//! sunameri: 省メモリ Web ブラウザの最小シェル(Phase 0)
//!
//! 使い方:
//!   sunameri [URL] [--no-js] [--screenshot OUT.png] [--width W] [--height H]
//!
//! URL を取得し、Blitz(HTML/CSS)と blitz-vibey-script(Boa による JavaScript 実行)で
//! 描画する。描画は CPU ラスタライザ(vello_cpu)で行う。
//! `--screenshot` を付けるとウィンドウを開かず、描画結果を PNG に書き出して終了する。

mod shell;

use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyrender::{PaintScene as _, render_to_buffer};
use anyrender_vello_cpu::{VelloCpuImageRenderer, VelloCpuWindowRenderer as WindowRenderer};
use blitz_dom::{Document, DocumentConfig, UserAgentStylesheet, util::Color};
use blitz_html::{HtmlDocument, HtmlProvider};
use sunameri_net::{CookieJar, FetchRequest, Net, NetHandle};
use blitz_paint::paint_scene;
use blitz_shell::{BlitzShellProxy, WindowConfig, create_default_event_loop};
use blitz_traits::navigation::{NavigationOptions, NavigationProvider};
use blitz_traits::net::{Body, Request};
use blitz_traits::shell::{ColorScheme, Viewport};
use blitz_vibey_script::{DefaultScriptFetcher, FetchError, ScriptDocument, ScriptFetcher};
use peniko::Fill;
use peniko::kurbo::Rect;
use url::Url;

const DEFAULT_URL: &str = "https://example.com/";
/// NetWalker PC-Z1 の画面サイズを既定値にする
const DEFAULT_WIDTH: u32 = 1024;
const DEFAULT_HEIGHT: u32 = 600;

struct Args {
    url: Url,
    enable_js: bool,
    screenshot: Option<PathBuf>,
    width: u32,
    height: u32,
    /// スクリーンショット前に JS のタイマーを回す時間(ms)
    settle_ms: u64,
    /// スクリーンショット後に DOM を標準出力へダンプする(先頭 N 文字)
    dump: Option<usize>,
    /// settle 後に評価する JS(ファイルパス)。評価後さらに settle_ms 待ってから描画する
    eval_file: Option<PathBuf>,
    /// URL が明示されたか(Cookie 取り込みだけで終了するかの判定に使う)
    url_given: bool,
    /// Cookie の保存先(None なら保存も読み込みもしない)
    cookies_file: Option<PathBuf>,
    /// 取り込む cookies.txt(Netscape 形式)
    import_cookies: Vec<PathBuf>,
    /// `Set-Cookie` 形式で直接追加する Cookie
    set_cookies: Vec<String>,
}

/// プロファイルの保存先。SUNAMERI_DATA_DIR で上書きできる。
/// macOS は ~/Library/Application Support/sunameri、それ以外は $XDG_DATA_HOME/sunameri
/// (無ければ ~/.local/share/sunameri)。
fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("SUNAMERI_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    if cfg!(target_os = "macos") {
        return std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support/sunameri"));
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(xdg).join("sunameri"));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/sunameri"))
}

fn parse_args() -> Args {
    let mut url = None;
    let mut cookies_file = data_dir().map(|d| d.join("cookies.json"));
    let mut import_cookies = Vec::new();
    let mut set_cookies = Vec::new();
    let mut enable_js = true;
    let mut screenshot = None;
    let mut width = DEFAULT_WIDTH;
    let mut height = DEFAULT_HEIGHT;
    #[allow(unused_mut)]
    let mut settle_ms = 1000;
    let mut dump = None;
    let mut eval_file = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--no-js" => enable_js = false,
            "--screenshot" => screenshot = Some(PathBuf::from(it.next().expect("--screenshot needs a path"))),
            "--width" => width = it.next().and_then(|v| v.parse().ok()).expect("--width needs a number"),
            "--eval" => eval_file = Some(PathBuf::from(it.next().expect("--eval needs a path"))),
            "--dump" => dump = Some(it.next().and_then(|v| v.parse().ok()).unwrap_or(20000)),
            "--settle" => settle_ms = it.next().and_then(|v| v.parse().ok()).expect("--settle needs ms"),
            "--height" => height = it.next().and_then(|v| v.parse().ok()).expect("--height needs a number"),
            "--cookies-file" => cookies_file = Some(PathBuf::from(it.next().expect("--cookies-file needs a path"))),
            "--no-cookies" => cookies_file = None,
            "--import-cookies" => import_cookies.push(PathBuf::from(it.next().expect("--import-cookies needs a path"))),
            "--set-cookie" => set_cookies.push(it.next().expect("--set-cookie needs 'name=value; Domain=...'")),
            "-h" | "--help" => {
                eprintln!("usage: sunameri [URL] [--no-js] [--screenshot OUT.png] [--width W] [--height H] [--settle MS] [--dump N] [--eval FILE.js]");
                eprintln!("       [--cookies-file FILE] [--no-cookies] [--import-cookies cookies.txt] [--set-cookie 'name=value; Domain=.example.com; Path=/; Secure']");
                eprintln!("Cookie は {} に保存される(SUNAMERI_DATA_DIR で変更可)。", data_dir().map(|d| d.join("cookies.json").display().to_string()).unwrap_or_default());
                eprintln!("--import-cookies / --set-cookie だけを指定して URL を省略すると、取り込んで保存した後に終了する。");
                std::process::exit(0);
            }
            other => url = Some(other.to_owned()),
        }
    }
    let url_given = url.is_some();
    let raw = url.unwrap_or_else(|| DEFAULT_URL.to_owned());
    // スキーム省略を許容する(例: `sunameri example.com`)
    let url = Url::parse(&raw)
        .or_else(|_| Url::parse(&format!("https://{raw}")))
        .unwrap_or_else(|err| {
            eprintln!("invalid URL {raw}: {err}");
            std::process::exit(2);
        });
    Args { url, enable_js, screenshot, width, height, settle_ms, dump, eval_file, url_given, cookies_file, import_cookies, set_cookies }
}

/// SUNAMERI_DUMP_PAINT=1: ペイントツリー(描画順)を stderr に出す(描画順の調査用)
fn dump_paint_tree(doc: &blitz_dom::BaseDocument) {
    if std::env::var_os("SUNAMERI_DUMP_PAINT").is_none() {
        return;
    }
    fn label(doc: &blitz_dom::BaseDocument, id: blitz_dom::NodeId) -> String {
        let node = &doc.tree()[id];
        match node.element_data() {
            Some(el) => {
                let id_attr = el.attr(blitz_dom::local_name!("id")).unwrap_or("");
                let class = el.attr(blitz_dom::local_name!("class")).unwrap_or("");
                let pos = node.primary_styles().map(|s| format!("{:?}", s.clone_position())).unwrap_or_default();
                format!("<{} id={:?} class={:?} pos={} z={}>", el.name.local, id_attr, &class[..class.len().min(50)], pos, node.z_index())
            }
            None => format!("{}", if node.is_text_node() { "text" } else { "anon" }),
        }
    }
    fn walk(doc: &blitz_dom::BaseDocument, id: blitz_dom::NodeId, depth: usize) {
        let node = &doc.tree()[id];
        let indent = "  ".repeat(depth);
        eprintln!("{indent}{} [{:?}]", label(doc, id), id);
        if let Some(sc) = &node.stacking_context {
            for h in sc.neg_z_hoisted_children() {
                eprintln!("{indent}  (neg-z hoisted)");
                walk(doc, h.node_id, depth + 2);
            }
        }
        if let Some(children) = &*node.paint_children.borrow() {
            for c in children {
                walk(doc, *c, depth + 1);
            }
        }
        if let Some(sc) = &node.stacking_context {
            for h in sc.pos_z_hoisted_children() {
                eprintln!("{indent}  (pos-z hoisted)");
                walk(doc, h.node_id, depth + 2);
            }
        }
    }
    eprintln!("[paint-tree]");
    walk(doc, doc.root_element().id, 0);
}

/// ヘッドレスモードの CSS アニメーション用の時刻(秒)。Blitz の resolve に渡す。
/// 0 固定だとアニメーションが進まず、フェードインする要素が透明のままになる。
fn animation_clock() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64()
}

/// 終了時(main から抜けるとき)に変更があれば Cookie を保存する
struct CookieSaver {
    jar: Arc<sunameri_net::CookieJar>,
    path: Option<PathBuf>,
}

impl Drop for CookieSaver {
    fn drop(&mut self) {
        save_cookies(&self.jar, self.path.as_deref());
    }
}

/// 変更があれば Cookie をファイルへ保存する
pub(crate) fn save_cookies(jar: &sunameri_net::CookieJar, path: Option<&std::path::Path>) {
    let Some(path) = path else { return };
    if !jar.is_dirty() {
        return;
    }
    match jar.save_to_file(path) {
        Ok(()) => log::debug!("cookies saved to {}", path.display()),
        Err(err) => eprintln!("[sunameri] cannot save cookies to {}: {err}", path.display()),
    }
}

/// 起動時の Cookie 読み込みと `--import-cookies` / `--set-cookie` の取り込み。
/// 取り込みだけが目的(URL 省略)なら保存して true を返す(呼び出し側で終了する)。
fn setup_cookies(args: &Args, jar: &sunameri_net::CookieJar) -> bool {
    if let Some(path) = &args.cookies_file {
        match jar.load_from_file(path) {
            Ok(n) if n > 0 => eprintln!("[sunameri] {n} cookies loaded from {}", path.display()),
            Ok(_) => {}
            Err(err) => eprintln!("[sunameri] cannot load cookies from {}: {err}", path.display()),
        }
    }
    let mut imported = 0;
    for file in &args.import_cookies {
        match std::fs::read_to_string(file) {
            Ok(text) => {
                let n = jar.import_netscape(&text);
                eprintln!("[sunameri] {n} cookies imported from {}", file.display());
                imported += n;
            }
            Err(err) => eprintln!("[sunameri] cannot read {}: {err}", file.display()),
        }
    }
    for header in &args.set_cookies {
        if jar.set_cookie_header(&args.url, header) {
            imported += 1;
        } else {
            eprintln!("[sunameri] ignored --set-cookie {header:?}");
        }
    }
    let import_only = !args.url_given && (!args.import_cookies.is_empty() || !args.set_cookies.is_empty());
    if import_only {
        if imported > 0 {
            let mut names = jar.names();
            names.sort();
            for (domain, name) in names {
                eprintln!("[sunameri]   {domain}: {name}");
            }
        }
        match &args.cookies_file {
            Some(path) => {
                if let Err(err) = jar.save_to_file(path) {
                    eprintln!("[sunameri] cannot save cookies to {}: {err}", path.display());
                } else {
                    eprintln!("[sunameri] cookies saved to {}", path.display());
                }
            }
            None => eprintln!("[sunameri] --no-cookies のため保存しません"),
        }
    }
    import_only
}

/// 事前取得した外部スクリプトをメモリから返す ScriptFetcher。
/// vibey-script の ScriptFetcher は同期 API なので、HTTP 取得は先に非同期で済ませておく。
struct PrefetchedScriptFetcher {
    scripts: HashMap<Url, String>,
}

impl ScriptFetcher for PrefetchedScriptFetcher {
    fn fetch(&self, url: &Url) -> Result<String, FetchError> {
        if let Some(src) = self.scripts.get(url) {
            return Ok(src.clone());
        }
        DefaultScriptFetcher.fetch(url)
    }
}

/// vibey-script の非同期 HTTP フックを sunameri-net で実装する
struct NetHttpFetcher(Arc<Net>);

impl blitz_vibey_script::HttpFetcher for NetHttpFetcher {
    fn fetch(
        &self,
        request: blitz_vibey_script::HttpRequest,
        done: Box<dyn FnOnce(Result<blitz_vibey_script::HttpResponse, String>) + Send + 'static>,
    ) {
        let req = FetchRequest {
            url: request.url,
            method: request.method,
            headers: request.headers,
            body: request.body,
            follow_redirects: request.follow_redirects,
        };
        self.0.spawn_fetch_full(
            req,
            Box::new(move |result| {
                done(result
                    .map(|r| blitz_vibey_script::HttpResponse {
                        status: r.status,
                        status_text: r.status_text,
                        url: r.url,
                        headers: r.headers,
                        body: r.body,
                        redirected: r.redirected,
                    })
                    .map_err(|e| e.to_string()));
            }),
        );
    }
}

/// `document.cookie` を共有 Cookie ジャーに繋ぐ
struct NetCookieJar(Arc<CookieJar>);

impl blitz_vibey_script::CookieJar for NetCookieJar {
    fn get(&self, url: &Url) -> String {
        self.0.document_cookie(url)
    }
    fn set(&self, url: &Url, cookie: &str) {
        self.0.set_from_document(url, cookie);
    }
}

/// vibey-script の console.* は `log` クレートに流れるので、標準エラーへ出す簡易ロガーを入れる
struct ConsoleLogger;
impl log::Log for ConsoleLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        // console.* は debug レベルで target "js_console" に出る
        metadata.target() == "js_console" || metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.target(), record.args());
            // SUNAMERI_TRACE_PAINT: 描画側の警告(NaN パスなど)の呼び出し元を一度だけ出す
            if record.target().starts_with("vello")
                && std::env::var_os("SUNAMERI_TRACE_PAINT").is_some()
            {
                static ONCE: std::sync::Once = std::sync::Once::new();
                ONCE.call_once(|| {
                    eprintln!("{}", std::backtrace::Backtrace::force_capture());
                });
            }
        }
    }
    fn flush(&self) {}
}
static LOGGER: ConsoleLogger = ConsoleLogger;

/// JS 実行(Boa)は深い再帰を使うので、ヘッドレスモードでは大きなスタックのスレッドで動かす。
/// ウィンドウモードは macOS の制約でメインスレッドが必要なため、リンカオプションでスタックを広げている
/// (.cargo/config.toml を参照)。
const HEADLESS_STACK_BYTES: usize = 512 * 1024 * 1024;

fn main() {
    let args = parse_args();
    log::set_logger(&LOGGER).expect("logger");
    log::set_max_level(log::LevelFilter::Debug);
    if args.screenshot.is_some() {
        let handle = std::thread::Builder::new()
            .name("sunameri-headless".into())
            .stack_size(HEADLESS_STACK_BYTES)
            .spawn(move || run(args))
            .expect("spawn headless thread");
        handle.join().expect("headless thread panicked");
    } else {
        run(args);
    }
}

/// blitz-dom が通知するナビゲーション(リンククリック、フォーム送信)を受け取る
struct SlotNavigation(Arc<Mutex<Option<NavigationOptions>>>);

impl NavigationProvider for SlotNavigation {
    fn navigate_to(&self, options: NavigationOptions) {
        eprintln!("[sunameri] navigation requested: {} {}", options.method, options.url);
        *self.0.lock().unwrap() = Some(options);
    }
}

/// 次に読み込むドキュメント
pub(crate) struct NavRequest {
    pub(crate) url: Url,
    pub(crate) method: String,
    pub(crate) body: Option<Vec<u8>>,
    pub(crate) content_type: Option<String>,
}

impl NavRequest {
    pub(crate) fn get(url: Url) -> Self {
        Self { url, method: "GET".into(), body: None, content_type: None }
    }

    /// blitz-dom のナビゲーション要求(リンク、フォーム送信)から変換する
    pub(crate) fn from_options(options: NavigationOptions) -> Self {
        let content_type = options.content_type.clone();
        let method = options.method.to_string();
        let url = options.url.clone();
        let body = match options.document_resource {
            Body::Bytes(bytes) => Some(bytes.to_vec()),
            Body::Form(form) => Some(
                form.iter()
                    .map(|e| format!("{}={}", urlencode(&e.name), urlencode(e.value.as_ref())))
                    .collect::<Vec<_>>()
                    .join("&")
                    .into_bytes(),
            ),
            Body::Empty => None,
        };
        Self { url, method, body, content_type }
    }
}

/// ドキュメントの取得と構築
pub(crate) struct Loader {
    pub(crate) handle: tokio::runtime::Handle,
    pub(crate) net: Arc<Net>,
    user_agent: &'static str,
    width: u32,
    height: u32,
    nav_slot: Arc<Mutex<Option<NavigationOptions>>>,
    /// JS が有効か(noscript の扱いに使う)
    scripting: bool,
}

impl Loader {
    /// ドキュメントを取得する。HTTP エラーでも本文(エラーページ)を返す。
    fn fetch_document(&self, req: &NavRequest) -> (String, String) {
        eprintln!("[sunameri] fetching {} {}", req.method, req.url);
        let mut headers = Vec::new();
        if let Some(ct) = &req.content_type {
            headers.push(("content-type".to_string(), ct.clone()));
        }
        let resp = self
            .handle
            .block_on(self.net.fetch_full(FetchRequest {
                url: req.url.clone(),
                method: req.method.clone(),
                headers,
                body: req.body.clone(),
                follow_redirects: true,
            }))
            .unwrap_or_else(|err| {
                eprintln!("[sunameri] fetch failed: {err}");
                std::process::exit(1);
            });
        eprintln!(
            "[sunameri] HTTP {} {} bytes from {}",
            resp.status,
            resp.body.len(),
            resp.url
        );
        (resp.url, String::from_utf8_lossy(&resp.body).into_owned())
    }

    /// UA スタイルシート。JS 有効時は `<noscript>` を隠す(Blitz の既定シートは
    /// `@media (scripting)` で隠そうとするが、この媒体特性が評価されないため表示されてしまう)
    fn ua_stylesheets(&self) -> Vec<UserAgentStylesheet> {
        let mut sheets = vec![UserAgentStylesheet::default_sheet()];
        if self.scripting {
            sheets.push(UserAgentStylesheet::parse("noscript { display: none !important; }"));
        }
        sheets
    }

    fn config(&self, base_url: String) -> DocumentConfig {
        DocumentConfig {
            base_url: Some(base_url),
            ua_stylesheets: self.ua_stylesheets(),
            net_provider: Some(Arc::new(NetHandle(Arc::clone(&self.net)))),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            navigation_provider: Some(Arc::new(SlotNavigation(Arc::clone(&self.nav_slot)))),
            viewport: Some(Viewport::new(self.width, self.height, 1.0, ColorScheme::Light)),
            ..Default::default()
        }
    }

    /// iframe のサブドキュメントとして表示するページ用の設定(ビューポートはレイアウトが決める)
    pub(crate) fn config_for_page(&self, base_url: String) -> DocumentConfig {
        DocumentConfig {
            base_url: Some(base_url),
            ua_stylesheets: self.ua_stylesheets(),
            net_provider: Some(Arc::new(NetHandle(Arc::clone(&self.net)))),
            html_parser_provider: Some(Arc::new(HtmlProvider)),
            viewport: None,
            subdocument_depth: 1,
            ..Default::default()
        }
    }

    /// HTML から JS 有効のドキュメントを構築し、スクリプトを実行する
    pub(crate) fn load_script_document(
        &self,
        html: &str,
        config: DocumentConfig,
        navigation_hook: Option<Arc<dyn Fn(blitz_vibey_script::PendingNavigation) + Send + Sync>>,
    ) -> ScriptDocument {
        let doc = ScriptDocument::from_html(html, config);

        // vibey-script の ScriptFetcher は同期 API なので、外部スクリプトは先に取得しておく
        let mut scripts: HashMap<Url, String> = HashMap::new();
        for url in doc.external_script_urls() {
            if scripts.contains_key(&url) || url.scheme() == "file" {
                continue;
            }
            match self.handle.block_on(self.net.fetch_bytes(Request::get(url.clone()))) {
                Ok((_, bytes)) => {
                    eprintln!("[sunameri] script {} ({} bytes)", url, bytes.len());
                    scripts.insert(url, String::from_utf8_lossy(&bytes).into_owned());
                }
                Err(err) => eprintln!("[sunameri] script fetch failed {url}: {err}"),
            }
        }

        let mut doc: ScriptDocument = doc
            .with_fetcher(PrefetchedScriptFetcher { scripts })
            .with_http_fetcher(Arc::new(NetHttpFetcher(Arc::clone(&self.net))))
            .with_cookie_jar(Arc::new(NetCookieJar(self.net.cookies())));
        if let Some(hook) = navigation_hook {
            doc = doc.with_navigation_hook(hook);
        }
        // ポリフィルが参照する設定(UA など)
        doc.eval(&format!(
            "globalThis.__sunameri_config = {{ userAgent: {:?}, language: \"ja\", languages: [\"ja\", \"en-US\", \"en\"], platform: \"Linux armv7l\" }};",
            self.user_agent
        ));
        // デバッグ用: ページのスクリプトより前に評価する JS(環境変数 SUNAMERI_PRELUDE=path)
        if let Some(path) = std::env::var_os("SUNAMERI_PRELUDE") {
            match std::fs::read_to_string(&path) {
                Ok(code) => doc.eval(&code),
                Err(err) => eprintln!("[sunameri] cannot read prelude {}: {err}", path.to_string_lossy()),
            }
        }
        doc.execute_scripts();
        report(&mut doc);
        doc
    }

    /// JS または blitz-dom が要求したナビゲーションを取り出す
    fn take_navigation(&self, doc: &mut ScriptDocument) -> Option<NavRequest> {
        if let Some(nav) = doc.take_navigation() {
            return Some(NavRequest {
                url: nav.url,
                method: nav.method,
                body: nav.body,
                content_type: nav.content_type,
            });
        }
        let options = self.nav_slot.lock().unwrap().take()?;
        Some(NavRequest::from_options(options))
    }

    /// サブリソースが全て届き、かつ settle_ms が経過するまで、タイマー実行(poll)と resolve を繰り返す。
    /// React などはタイマー経由で描画をコミットするので、スクリプト実行直後では DOM が空のことがある。
    /// ナビゲーションが要求されたら早めに抜ける。
    fn settle(&self, doc: &mut ScriptDocument, settle_ms: u64) {
        let start = std::time::Instant::now();
        let mut spins = 0;
        loop {
            doc.poll(None);
            doc.inner_mut().resolve(animation_clock());
            let settled = start.elapsed().as_millis() as u64 >= settle_ms;
            if (self.net.is_empty() && settled) || spins > 4000 {
                break;
            }
            if doc.has_pending_navigation() || self.nav_slot.lock().unwrap().is_some() {
                break;
            }
            spins += 1;
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        report(doc);
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 溜まったコンソールメッセージと JS エラーを出力する
pub(crate) fn report(doc: &mut ScriptDocument) {
    for msg in doc.take_messages() {
        println!("[console] {msg}");
    }
    for err in doc.take_js_errors() {
        eprintln!("[js error] {err}");
    }
}

/// ヘッドレスで辿るナビゲーションの上限
const MAX_NAVIGATIONS: usize = 10;

fn run(args: Args) {
    // NetWalker(シングルコア)を意識してワーカースレッドは最小限にする
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _guard = rt.enter();

    // ウィンドウモードでは event loop の proxy を NetProvider の waker にする。
    // スクリーンショットモードでは event loop を作らない(macOS ではメインスレッド制約があるため、
    // 作るだけでもウィンドウサーバに接続してしまう)。
    let user_agent = sunameri_net::DEFAULT_USER_AGENT;
    let root_doc_id = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (event_loop, proxy, receiver, net) = if args.screenshot.is_none() {
        let event_loop = create_default_event_loop();
        let (proxy, receiver) = BlitzShellProxy::new(event_loop.create_proxy());
        // 再描画要求はイベント経由にする(tokio スレッドから winit を直接呼ぶとデッドロックする)
        let waker = shell::ProxyRedraw {
            proxy: proxy.clone(),
            root_doc_id: Arc::clone(&root_doc_id),
            delegate: None,
            forward_title: true,
        };
        let net = Arc::new(Net::new(Some(Arc::new(waker)), user_agent));
        (Some(event_loop), Some(proxy), Some(receiver), net)
    } else {
        (None, None, None, Arc::new(Net::new(None, user_agent)))
    };
    // JS 有効時は <noscript> の中身を要素として解釈しない(ブラウザと同じ)
    blitz_html::set_scripting_enabled(args.enable_js);
    // Cookie の読み込みと取り込み。main から抜けるときに保存する
    let _cookie_saver = CookieSaver { jar: net.cookies(), path: args.cookies_file.clone() };
    if setup_cookies(&args, &net.cookies()) {
        return;
    }
    let loader = Loader {
        handle: rt.handle().clone(),
        net,
        scripting: args.enable_js,
        user_agent,
        width: args.width,
        height: args.height,
        nav_slot: Arc::new(Mutex::new(None)),
    };

    // ---- ウィンドウモード: シェル(ツールバー + iframe)を表示し、ページはサブドキュメントにする ----
    if args.screenshot.is_none() {
        let proxy = proxy.unwrap();
        let receiver = receiver.unwrap();
        let shell_proxy = proxy.clone();
        let message_hook: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |msg| {
            shell_proxy.send_event(shell::embed(shell::ShellEvent::Message(msg)));
        });
        let mut shell_doc = ScriptDocument::from_html(
            shell::SHELL_HTML,
            DocumentConfig {
                base_url: Some("sunameri://shell/".to_string()),
                ua_stylesheets: vec![UserAgentStylesheet::default_sheet()],
                net_provider: Some(Arc::new(NetHandle(Arc::clone(&loader.net)))),
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ..Default::default()
            },
        )
        .with_message_hook(message_hook);
        shell_doc.execute_scripts();
        report(&mut shell_doc);
        root_doc_id.store(shell_doc.id(), std::sync::atomic::Ordering::SeqCst);

        let attrs = winit::window::WindowAttributes::default()
            .with_title("sunameri")
            .with_surface_size(winit::dpi::LogicalSize::new(args.width as f64, args.height as f64));
        let window = WindowConfig::with_attributes(Box::new(shell_doc), WindowRenderer::new(), attrs);
        let mut application = shell::ShellApplication::new(proxy, receiver, loader, root_doc_id, args.cookies_file.clone());
        application.add_window(window);
        application.navigate(NavRequest::get(args.url.clone()));
        event_loop.unwrap().run_app(application).expect("event loop");
        return;
    }

    // ---- JS 無効 ----
    if !args.enable_js {
        let (final_url, html) = loader.fetch_document(&NavRequest::get(args.url.clone()));
        let mut doc = HtmlDocument::from_html(&html, loader.config(final_url));
        if let Some(out) = &args.screenshot {
            let start = std::time::Instant::now();
            loop {
                doc.inner_mut().resolve(animation_clock());
                if loader.net.is_empty() && start.elapsed().as_millis() as u64 >= args.settle_ms {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            dump_paint_tree(&doc.inner());
            render_png(&mut doc, out, args.width, args.height);
            return;
        }
        return;
    }

    // ---- JS 有効 ----
    let mut next = Some(NavRequest::get(args.url.clone()));
    let mut hops = 0;
    let mut evaluated = false;
    while let Some(req) = next.take() {
        hops += 1;
        if hops > MAX_NAVIGATIONS {
            eprintln!("[sunameri] too many navigations, stopping");
            return;
        }
        let (final_url, html) = loader.fetch_document(&req);
        loader.net.set_document_url(Url::parse(&final_url).ok());
        let mut doc = loader.load_script_document(&html, loader.config(final_url), None);

        let Some(out) = &args.screenshot else { return };

        loader.settle(&mut doc, args.settle_ms);
        if let Some(nav) = loader.take_navigation(&mut doc) {
            eprintln!("[sunameri] navigating to {} {}", nav.method, nav.url);
            next = Some(nav);
            continue;
        }
        if !evaluated && let Some(path) = &args.eval_file {
            evaluated = true;
            let code = std::fs::read_to_string(path).unwrap_or_else(|err| {
                eprintln!("[sunameri] cannot read {}: {err}", path.display());
                std::process::exit(1);
            });
            eprintln!("[sunameri] eval {}", path.display());
            doc.eval(&code);
            loader.settle(&mut doc, args.settle_ms);
            if let Some(nav) = loader.take_navigation(&mut doc) {
                eprintln!("[sunameri] navigating to {} {}", nav.method, nav.url);
                next = Some(nav);
                continue;
            }
        }
        dump_paint_tree(&doc.inner());
            render_png(&mut doc, out, args.width, args.height);
        if let Some(n) = args.dump {
            doc.eval(&format!(
                "console.log('[dump] title=' + JSON.stringify(document.title) + ' url=' + location.href); console.log('[dump] ' + document.documentElement.outerHTML.slice(0, {n}));"
            ));
        }
        report(&mut doc);
        return;
    }
}

/// ページ先頭 width×height を PNG に書き出す
fn render_png(doc: &mut dyn Document, out: &PathBuf, width: u32, height: u32) {
    doc.inner_mut().resolve(animation_clock());
    let buffer = render_to_buffer::<VelloCpuImageRenderer, _>(
        |scene| {
            scene.fill(
                Fill::NonZero,
                Default::default(),
                Color::WHITE,
                Default::default(),
                &Rect::new(0.0, 0.0, width as f64, height as f64),
            );
            paint_scene(scene, &mut *doc.inner_mut(), 1.0, width, height, 0, 0);
        },
        width,
        height,
    );

    let file = File::create(out).unwrap_or_else(|err| {
        eprintln!("[sunameri] cannot create {}: {err}", out.display());
        std::process::exit(1);
    });
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("png header");
    writer.write_image_data(&buffer).expect("png data");
    writer.finish().expect("png finish");
    eprintln!("[sunameri] screenshot written to {}", out.display());
}
