//! sunameri のネットワーク層。
//!
//! - TLS は rustls(ring)。OpenSSL に依存しないので armhf へのクロスビルドが楽になる。
//! - Cookie ジャーをプロセス内で共有し、`document.cookie` からも読み書きできるようにする
//!   (X は CSRF トークンを Cookie `ct0` から JS で読む)。
//! - JavaScript の `fetch` / `XMLHttpRequest` 向けに、ステータス・ヘッダ・本文を全て返す
//!   [`Net::fetch_full`] を提供する。
//! - [`blitz_traits::net::NetProvider`] も実装し、画像や CSS などのサブリソース取得にも使う。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use blitz_traits::net::{Body, Bytes, NetHandler, NetProvider, NetWaker, Request};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tokio::sync::Semaphore;
use url::Url;

/// 実ブラウザと同じ、オリジンごとの同時接続上限
const PER_HOST_MAX_CONCURRENT: usize = 6;

/// X が「非対応ブラウザ」と判定しないよう、一般的なデスクトップ Firefox を名乗る
pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux armv7l; rv:128.0) Gecko/20100101 Firefox/128.0";

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/// プロセス内で共有する Cookie ジャー
pub struct CookieJar {
    store: Mutex<cookie_store::CookieStore>,
    /// 最後に保存してから変更があったか
    dirty: std::sync::atomic::AtomicBool,
}

impl Default for CookieJar {
    fn default() -> Self {
        Self::new()
    }
}

impl CookieJar {
    pub fn new() -> Self {
        Self {
            store: Mutex::new(cookie_store::CookieStore::new()),
            dirty: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// 最後の保存以降に変更があれば true
    pub fn is_dirty(&self) -> bool {
        self.dirty.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// JSON ファイルから読み込む(既存の内容は置き換える)。ファイルが無ければ 0 を返す。
    pub fn load_from_file(&self, path: &std::path::Path) -> std::io::Result<usize> {
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(err) => return Err(err),
        };
        let loaded = cookie_store::serde::json::load(std::io::BufReader::new(file))
            .map_err(|err| std::io::Error::other(format!("cookie file {}: {err}", path.display())))?;
        let count = loaded.iter_unexpired().count();
        *self.store.lock().unwrap() = loaded;
        self.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
        Ok(count)
    }

    /// JSON ファイルへ保存する(期限付きの Cookie のみ。セッション Cookie は保存しない)。
    /// 一時ファイルに書いてから置き換えるので、途中で落ちても壊れない。
    pub fn save_to_file(&self, path: &std::path::Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        {
            let store = self.store.lock().unwrap();
            let mut file = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
            cookie_store::serde::json::save(&store, &mut file)
                .map_err(|err| std::io::Error::other(format!("cookie save: {err}")))?;
            use std::io::Write;
            file.flush()?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, path)?;
        self.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    /// `Set-Cookie` 形式の文字列を保存する(`--set-cookie` 用)。
    /// Domain 属性があればそのドメインへの応答として扱い、無ければ `url` への応答として扱う。
    pub fn set_cookie_header(&self, url: &Url, header: &str) -> bool {
        let Ok(mut parsed) = cookie::Cookie::parse(header.to_owned()) else {
            return false;
        };
        // 期限の無い Cookie はセッション Cookie としてファイルに保存されないので、
        // 手動で入れたものは 1 年後を期限にして保存対象にする
        if parsed.expires().is_none() && parsed.max_age().is_none() {
            parsed.set_expires(cookie::time::OffsetDateTime::now_utc() + cookie::time::Duration::days(365));
        }
        let target = parsed
            .domain()
            .and_then(|d| Url::parse(&format!("https://{}{}", d.trim_start_matches('.'), parsed.path().unwrap_or("/"))).ok())
            .unwrap_or_else(|| url.clone());
        let mut store = self.store.lock().unwrap();
        let ok = store.insert_raw(&parsed, &target).is_ok();
        drop(store);
        if ok {
            self.mark_dirty();
        }
        ok
    }

    /// Netscape 形式(cookies.txt。ブラウザの拡張機能が書き出す形式)を取り込む。
    /// 取り込んだ Cookie の数を返す。
    pub fn import_netscape(&self, text: &str) -> usize {
        let mut count = 0;
        let mut store = self.store.lock().unwrap();
        for raw_line in text.lines() {
            let line = raw_line.trim_end_matches('\r');
            let (http_only, line) = match line.strip_prefix("#HttpOnly_") {
                Some(rest) => (true, rest),
                None => (false, line),
            };
            if line.trim().is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 7 {
                continue;
            }
            let (domain, flag, path, secure, expires, name, value) = (
                fields[0], fields[1], fields[2], fields[3], fields[4], fields[5],
                fields[6..].join("\t"),
            );
            let host = domain.trim_start_matches('.');
            let path = if path.is_empty() { "/" } else { path };
            let mut builder = cookie::Cookie::build((name.to_owned(), value))
                .path(path.to_owned())
                .secure(secure.eq_ignore_ascii_case("TRUE"))
                .http_only(http_only);
            if domain.starts_with('.') || flag.eq_ignore_ascii_case("TRUE") {
                builder = builder.domain(host.to_owned());
            }
            if let Ok(ts) = expires.parse::<i64>()
                && ts > 0
                && let Ok(when) = cookie::time::OffsetDateTime::from_unix_timestamp(ts)
            {
                builder = builder.expires(when);
            }
            let raw = builder.build();
            let Ok(url) = Url::parse(&format!("https://{host}{path}")) else {
                continue;
            };
            if store.insert_raw(&raw, &url).is_ok() {
                count += 1;
            }
        }
        if count > 0 {
            drop(store);
            self.mark_dirty();
        }
        count
    }

    /// 保存している Cookie の (ドメイン, 名前) 一覧(確認表示用)
    pub fn names(&self) -> Vec<(String, String)> {
        self.store
            .lock()
            .unwrap()
            .iter_unexpired()
            .map(|c| (c.domain().unwrap_or("").to_owned(), c.name().to_owned()))
            .collect()
    }

    /// `Cookie:` リクエストヘッダの値(無ければ None)
    pub fn request_header(&self, url: &Url) -> Option<String> {
        let store = self.store.lock().unwrap();
        let header = store
            .get_request_values(url)
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        (!header.is_empty()).then_some(header)
    }

    /// `document.cookie` の getter 相当。HttpOnly な Cookie は含めない。
    pub fn document_cookie(&self, url: &Url) -> String {
        let store = self.store.lock().unwrap();
        store
            .matches(url)
            .into_iter()
            .filter(|c| !c.http_only().unwrap_or(false))
            .map(|c| format!("{}={}", c.name(), c.value()))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// `document.cookie = "..."` 相当
    pub fn set_from_document(&self, url: &Url, cookie_str: &str) {
        let mut store = self.store.lock().unwrap();
        match store.parse(cookie_str, url) {
            Ok(_) => self.mark_dirty(),
            Err(err) => log::debug!("document.cookie: ignored {cookie_str:?}: {err}"),
        }
    }

    /// `Set-Cookie` ヘッダ群を保存する
    pub fn store_set_cookies<'a>(&self, url: &Url, headers: impl Iterator<Item = &'a str>) {
        let mut store = self.store.lock().unwrap();
        let mut any = false;
        let cookies = headers.filter_map(|raw| cookie::Cookie::parse(raw.to_owned()).ok()).inspect(|_| any = true);
        store.store_response_cookies(cookies, url);
        if any {
            self.mark_dirty();
        }
    }

    /// 保存している Cookie の数(デバッグ用)
    pub fn len(&self) -> usize {
        self.store.lock().unwrap().iter_unexpired().count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl reqwest::cookie::CookieStore for CookieJar {
    fn set_cookies(&self, cookie_headers: &mut dyn Iterator<Item = &HeaderValue>, url: &Url) {
        let values: Vec<String> = cookie_headers
            .filter_map(|v| v.to_str().ok())
            .map(str::to_owned)
            .collect();
        self.store_set_cookies(url, values.iter().map(String::as_str));
    }

    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        self.request_header(url)
            .and_then(|h| HeaderValue::from_str(&h).ok())
    }
}

// ---------------------------------------------------------------------------
// fetch(全情報付き)
// ---------------------------------------------------------------------------

/// JavaScript の fetch / XHR からのリクエスト
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: Url,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// false なら 3xx をそのまま返す(`redirect: "manual"`)
    pub follow_redirects: bool,
}

impl FetchRequest {
    pub fn get(url: Url) -> Self {
        Self {
            url,
            method: "GET".into(),
            headers: Vec::new(),
            body: None,
            follow_redirects: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FetchResponse {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub redirected: bool,
}

#[derive(Debug)]
pub enum NetError {
    Io(std::io::Error),
    DataUrl(String),
    Http(reqwest::Error),
    /// 2xx 以外(サブリソース取得で使う)
    HttpStatus { status: u16, url: String },
    InvalidRequest(String),
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::DataUrl(e) => write!(f, "data url error: {e}"),
            Self::Http(e) => write!(f, "http error: {e}"),
            Self::HttpStatus { status, url } => write!(f, "HTTP {status} for {url}"),
            Self::InvalidRequest(e) => write!(f, "invalid request: {e}"),
        }
    }
}

impl std::error::Error for NetError {}

impl From<std::io::Error> for NetError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<reqwest::Error> for NetError {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e)
    }
}

type HostLimits = Arc<Mutex<HashMap<String, Arc<Semaphore>>>>;

/// ネットワーククライアント。`Arc` で共有して使う。
pub struct Net {
    /// リダイレクトを追うクライアント
    client: reqwest::Client,
    /// リダイレクトを追わないクライアント(fetch の `redirect: "manual"` 用)
    client_no_redirect: reqwest::Client,
    cookies: Arc<CookieJar>,
    waker: Arc<dyn NetWaker>,
    per_host_limits: HostLimits,
    /// 進行中のリクエスト数
    pending: Arc<AtomicUsize>,
    /// 現在のドキュメントの URL(Referer / Origin ヘッダに使う)
    document_url: Mutex<Option<Url>>,
}

struct DummyWaker;
impl NetWaker for DummyWaker {
    fn wake(&self, _: usize) {}
}

/// 進行中カウンタを RAII で減らす
struct PendingGuard(Arc<AtomicUsize>);
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Net {
    pub fn new(waker: Option<Arc<dyn NetWaker>>, user_agent: &str) -> Self {
        // rustls の暗号プロバイダを ring に固定する(aws-lc-rs はクロスビルドに C ツールチェーンが要る)
        let _ = rustls::crypto::ring::default_provider().install_default();

        let cookies = Arc::new(CookieJar::new());
        let build = |redirect: reqwest::redirect::Policy| {
            reqwest::Client::builder()
                .tls_backend_rustls()
                .user_agent(user_agent)
                .cookie_provider(Arc::clone(&cookies))
                .gzip(true)
                .brotli(true)
                .redirect(redirect)
                .build()
                .expect("reqwest client")
        };
        Self {
            client: build(reqwest::redirect::Policy::limited(10)),
            client_no_redirect: build(reqwest::redirect::Policy::none()),
            cookies,
            waker: waker.unwrap_or_else(|| Arc::new(DummyWaker)),
            per_host_limits: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(AtomicUsize::new(0)),
            document_url: Mutex::new(None),
        }
    }

    /// 現在表示中のドキュメントの URL を設定する(JS からのリクエストに Referer/Origin を付ける)
    pub fn set_document_url(&self, url: Option<Url>) {
        *self.document_url.lock().unwrap() = url;
    }

    pub fn cookies(&self) -> Arc<CookieJar> {
        Arc::clone(&self.cookies)
    }

    /// 進行中のリクエスト数
    pub fn pending(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }

    pub fn is_empty(&self) -> bool {
        self.pending() == 0
    }

    fn begin(&self) -> PendingGuard {
        self.pending.fetch_add(1, Ordering::SeqCst);
        PendingGuard(Arc::clone(&self.pending))
    }

    async fn host_permit(limits: HostLimits, url: &Url) -> tokio::sync::OwnedSemaphorePermit {
        let key = url.host_str().unwrap_or_default().to_owned();
        let semaphore = {
            let mut map = limits.lock().unwrap();
            map.entry(key)
                .or_insert_with(|| Arc::new(Semaphore::new(PER_HOST_MAX_CONCURRENT)))
                .clone()
        };
        semaphore.acquire_owned().await.expect("semaphore closed")
    }

    /// ステータス・ヘッダ・本文を全て返す fetch。file: と data: にも対応する。
    pub async fn fetch_full(&self, req: FetchRequest) -> Result<FetchResponse, NetError> {
        let _guard = self.begin();
        match req.url.scheme() {
            "data" => {
                let data_url = data_url::DataUrl::process(req.url.as_str())
                    .map_err(|e| NetError::DataUrl(format!("{e:?}")))?;
                let (body, _) = data_url
                    .decode_to_vec()
                    .map_err(|e| NetError::DataUrl(format!("{e:?}")))?;
                let mime = data_url.mime_type().to_string();
                Ok(FetchResponse {
                    status: 200,
                    status_text: "OK".into(),
                    url: req.url.to_string(),
                    headers: vec![("content-type".into(), mime)],
                    body,
                    redirected: false,
                })
            }
            "file" => {
                let path = req.url.to_file_path().map_err(|()| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a file path")
                })?;
                match std::fs::read(&path) {
                    Ok(body) => Ok(FetchResponse {
                        status: 200,
                        status_text: "OK".into(),
                        url: req.url.to_string(),
                        headers: Vec::new(),
                        body,
                        redirected: false,
                    }),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FetchResponse {
                        status: 404,
                        status_text: "Not Found".into(),
                        url: req.url.to_string(),
                        headers: Vec::new(),
                        body: Vec::new(),
                        redirected: false,
                    }),
                    Err(e) => Err(e.into()),
                }
            }
            _ => self.fetch_http(req).await,
        }
    }

    async fn fetch_http(&self, req: FetchRequest) -> Result<FetchResponse, NetError> {
        let _permit = Self::host_permit(Arc::clone(&self.per_host_limits), &req.url).await;

        let method = reqwest::Method::from_bytes(req.method.as_bytes())
            .map_err(|e| NetError::InvalidRequest(format!("method {}: {e}", req.method)))?;
        let client = if req.follow_redirects {
            &self.client
        } else {
            &self.client_no_redirect
        };
        let mut headers = HeaderMap::new();
        // ブラウザと同じく Referer と(クロスオリジンまたは GET 以外のとき)Origin を付ける
        if let Some(doc_url) = self.document_url.lock().unwrap().clone()
            && matches!(doc_url.scheme(), "http" | "https")
        {
            let mut referer = doc_url.clone();
            referer.set_fragment(None);
            referer.set_username("").ok();
            referer.set_password(None).ok();
            if let Ok(v) = HeaderValue::from_str(referer.as_str()) {
                headers.insert("referer", v);
            }
            let cross_origin = doc_url.origin() != req.url.origin();
            if (cross_origin || req.method != "GET") && let Ok(v) = HeaderValue::from_str(&doc_url.origin().ascii_serialization()) {
                headers.insert("origin", v);
            }
        }
        for (name, value) in &req.headers {
            match (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                (Ok(n), Ok(v)) => {
                    headers.append(n, v);
                }
                _ => log::debug!("fetch: dropping invalid header {name}: {value}"),
            }
        }
        let original_url = req.url.clone();
        let trace = std::env::var_os("SUNAMERI_TRACE_NET").is_some();
        if trace {
            eprintln!("[net] > {} {}", req.method, original_url);
            for (k, v) in headers.iter() {
                eprintln!("[net] >   {}: {}", k, trace_header_value(k.as_str(), v.as_bytes()));
            }
            if let Some(body) = &req.body {
                eprintln!("[net] >   body {}", trace_body(body, 200));
            }
        }
        let mut builder = client.request(method, req.url).headers(headers);
        if let Some(body) = req.body {
            builder = builder.body(body);
        }
        let response = builder.send().await?;
        let status = response.status();
        let final_url = response.url().to_string();
        let redirected = response.url() != &original_url;
        if trace {
            eprintln!("[net] < {} {}", status, final_url);
            for (k, v) in response.headers().iter() {
                eprintln!("[net] <   {}: {}", k, trace_header_value(k.as_str(), v.as_bytes()));
            }
        }
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_owned(),
                    String::from_utf8_lossy(v.as_bytes()).into_owned(),
                )
            })
            .collect();
        let is_json = response
            .headers()
            .get("content-type")
            .map(|v| String::from_utf8_lossy(v.as_bytes()).contains("json"))
            .unwrap_or(false);
        let body = response.bytes().await?.to_vec();
        if trace {
            // エラー応答と API の JSON は原因調査に本文が要るので長めに出す
            let limit = if !status.is_success() || is_json { 2000 } else { 400 };
            eprintln!("[net] <   body {}", trace_body(&body, limit));
        }
        Ok(FetchResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_owned(),
            url: final_url,
            headers,
            body,
            redirected,
        })
    }

    /// `fetch_full` を tokio 上で実行し、完了時にコールバックを呼ぶ(呼び出し元スレッドは問わない)
    pub fn spawn_fetch_full(
        self: &Arc<Self>,
        req: FetchRequest,
        callback: Box<dyn FnOnce(Result<FetchResponse, NetError>) + Send + 'static>,
    ) {
        let net = Arc::clone(self);
        tokio::spawn(async move {
            let result = net.fetch_full(req).await;
            callback(result);
        });
    }

    /// ドキュメントやサブリソース用: 2xx の本文だけを返す
    pub async fn fetch_bytes(&self, request: Request) -> Result<(String, Bytes), NetError> {
        let body = match request.body {
            Body::Bytes(bytes) => Some(bytes.to_vec()),
            Body::Form(form) => {
                // application/x-www-form-urlencoded としてエンコードする
                let encoded = form
                    .iter()
                    .map(|entry| {
                        format!(
                            "{}={}",
                            urlencode(&entry.name),
                            urlencode(entry.value.as_ref())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("&");
                Some(encoded.into_bytes())
            }
            Body::Empty => None,
        };
        let mut headers: Vec<(String, String)> = request
            .headers
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_owned(),
                    String::from_utf8_lossy(v.as_bytes()).into_owned(),
                )
            })
            .collect();
        if let Some(ct) = request.content_type {
            headers.push(("content-type".into(), ct));
        }
        let response = self
            .fetch_full(FetchRequest {
                url: request.url,
                method: request.method.to_string(),
                headers,
                body,
                follow_redirects: true,
            })
            .await?;
        if (200..300).contains(&response.status) {
            Ok((response.url, Bytes::from(response.body)))
        } else {
            Err(NetError::HttpStatus {
                status: response.status,
                url: response.url,
            })
        }
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// [`NetProvider`] として blitz-dom に渡すためのハンドル
#[derive(Clone)]
pub struct NetHandle(pub Arc<Net>);

impl NetProvider for NetHandle {
    fn fetch(&self, doc_id: usize, mut request: Request, handler: Box<dyn NetHandler>) {
        let net = Arc::clone(&self.0);
        let signal = request.signal.take();
        let url = request.url.to_string();
        tokio::spawn(async move {
            if signal.as_ref().is_some_and(|s| s.aborted()) {
                return;
            }
            let result = net.fetch_bytes(request).await;
            net.waker.wake(doc_id);
            match result {
                Ok((resolved_url, bytes)) => handler.bytes(resolved_url, bytes),
                Err(err) => log::debug!("subresource {url}: {err}"),
            }
        });
    }
}

/// トレース出力用にヘッダ値を加工する。Cookie や認証トークンはログを共有しても困らないよう伏せる。
/// `SUNAMERI_TRACE_NET=full` のときだけ生の値を出す。
fn trace_header_value(name: &str, value: &[u8]) -> String {
    let full = std::env::var("SUNAMERI_TRACE_NET").map(|v| v == "full").unwrap_or(false);
    let sensitive = matches!(
        name.to_ascii_lowercase().as_str(),
        "cookie" | "set-cookie" | "authorization" | "x-csrf-token" | "x-guest-token"
    );
    let text = String::from_utf8_lossy(value);
    if full || !sensitive {
        return text.into_owned();
    }
    if name.eq_ignore_ascii_case("cookie") || name.eq_ignore_ascii_case("set-cookie") {
        // 名前だけ残して値を伏せる(どの Cookie が付いたかは分かるようにする)
        // Set-Cookie は先頭の名前=値だけが秘密で、Path や Expires などの属性はそのまま出してよい
        let is_set_cookie = name.eq_ignore_ascii_case("set-cookie");
        text.split(';')
            .enumerate()
            .map(|(i, part)| {
                let part = part.trim();
                match part.split_once('=') {
                    Some((k, v)) if i == 0 || !is_set_cookie => format!("{k}=<{} bytes>", v.len()),
                    _ => part.to_owned(),
                }
            })
            .collect::<Vec<_>>()
            .join("; ")
    } else {
        format!("<{} bytes>", value.len())
    }
}

/// トレース出力用に本文を加工する。パスワードらしき内容を含む本文は長さだけ出す。
fn trace_body(body: &[u8], limit: usize) -> String {
    let full = std::env::var("SUNAMERI_TRACE_NET").map(|v| v == "full").unwrap_or(false);
    let text = String::from_utf8_lossy(&body[..body.len().min(limit.max(4096))]);
    if !full && text.contains("password") {
        return format!("{} bytes (伏せました: password を含む)", body.len());
    }
    let shown: String = text.chars().take(limit).collect();
    format!("{} bytes: {}", body.len(), shown.replace('\n', " "))
}
