//! 埋め込み側(ブラウザシェル)へのフック: 非同期 HTTP(`fetch` / `XMLHttpRequest` /
//! 動的に挿入された `<script src>`)、Cookie、乱数、イベントリスナ列挙。
//!
//! 上流 blitz-vibey-script の `fetch()` は同期的な [`ScriptFetcher`](crate::ScriptFetcher)
//! 経由で file:/data: しか扱えない。sunameri ではここで定義する [`HttpFetcher`] を
//! 埋め込み側が実装し、HTTP(S) を非同期に処理する。完了はチャネルで通知され、
//! [`ScriptDocument::poll`](crate::ScriptDocument) の中で Promise を解決する。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::task::Waker;

use blitz_dom::NodeId;
use boa_engine::builtins::promise::ResolvingFunctions;
use boa_engine::object::builtins::{JsArray, JsPromise, JsUint8Array};
use boa_engine::{Context, JsNativeError, JsResult, JsString, JsValue, Source};
use url::Url;

use crate::dom::{dom_ctx, js_str, node_id_of_value, to_rust_string};
use crate::runtime::{ScriptRuntime, register_global_fn, report_js_error};
use crate::state::{DomCtx, Listener};

/// JavaScript から発行される HTTP リクエスト
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub url: Url,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// false なら 3xx をそのまま返す(`redirect: "manual"`)
    pub follow_redirects: bool,
}

/// HTTP 応答(本文は全て読み終えたもの)
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub redirected: bool,
}

/// 非同期 HTTP を提供する埋め込み側のフック。
/// `done` はどのスレッドから呼んでもよい。
pub trait HttpFetcher: Send + Sync + 'static {
    fn fetch(
        &self,
        request: HttpRequest,
        done: Box<dyn FnOnce(Result<HttpResponse, String>) + Send + 'static>,
    );
}

/// `document.cookie` の読み書き先
pub trait CookieJar: Send + Sync + 'static {
    /// `document.cookie` getter(HttpOnly を除く "a=b; c=d")
    fn get(&self, url: &Url) -> String;
    /// `document.cookie = "..."` setter
    fn set(&self, url: &Url, cookie: &str);
}

/// HTTP をブロッキングで取得する(ES モジュールの import 用)
pub(crate) fn fetch_text_blocking(http: &Arc<dyn HttpFetcher>, url: &Url) -> Result<String, String> {
    log::info!(target: "sunameri_net", "module {url}");
    let (tx, rx) = channel();
    http.fetch(
        HttpRequest {
            url: url.clone(),
            method: "GET".into(),
            headers: Vec::new(),
            body: None,
            follow_redirects: true,
        },
        Box::new(move |result| {
            let _ = tx.send(result);
        }),
    );
    let resp = rx.recv().map_err(|_| "fetch cancelled".to_string())??;
    if (200..300).contains(&resp.status) {
        Ok(String::from_utf8_lossy(&resp.body).into_owned())
    } else {
        Err(format!("HTTP {}", resp.status))
    }
}

/// JavaScript(location.assign、フォーム送信、リンクの click())が要求したナビゲーション
#[derive(Debug, Clone)]
pub struct PendingNavigation {
    pub url: Url,
    pub method: String,
    pub body: Option<Vec<u8>>,
    pub content_type: Option<String>,
    /// true なら履歴を置き換える(location.replace)
    pub replace: bool,
}

/// 完了した非同期処理
pub(crate) enum AsyncDone {
    Fetch {
        id: u64,
        result: Result<HttpResponse, String>,
    },
    Script {
        node_id: NodeId,
        url: Url,
        is_module: bool,
        result: Result<HttpResponse, String>,
    },
    /// `<link rel="modulepreload|preload|prefetch|stylesheet">` の取得完了(load/error イベント用)
    Resource {
        node_id: NodeId,
        url: Url,
        is_module: bool,
        result: Result<HttpResponse, String>,
    },
}

/// 非同期処理の状態(RuntimeState の一部)
pub(crate) struct AsyncState {
    pub http: Option<Arc<dyn HttpFetcher>>,
    pub cookies: Option<Arc<dyn CookieJar>>,
    pub tx: Sender<AsyncDone>,
    pub rx: Receiver<AsyncDone>,
    /// 未解決の fetch Promise
    pub pending: HashMap<u64, ResolvingFunctions>,
    pub next_id: u64,
    /// 進行中の非同期処理数(fetch と script)
    pub in_flight: usize,
    /// 完了時にイベントループを起こすための waker(ScriptDocument と共有)
    pub waker: Arc<Mutex<Option<Waker>>>,
    /// 実行済み(または実行をスケジュール済み)の script 要素
    pub executed_scripts: HashSet<NodeId>,
    /// JS が要求したナビゲーション(埋め込み側が取り出して処理する)
    pub navigation: Option<PendingNavigation>,
    /// ナビゲーション要求を即座に埋め込み側へ渡すコールバック(設定時は `navigation` に溜めない)
    pub navigation_hook: Option<Arc<dyn Fn(PendingNavigation) + Send + Sync>>,
    /// `__blitz_send_message` を即座に埋め込み側へ渡すコールバック
    pub message_hook: Option<Arc<dyn Fn(String) + Send + Sync>>,
    /// `<link rel="modulepreload">` で先読みしたモジュールのソース(モジュールローダが使う)
    pub preloaded_modules: HashMap<Url, String>,
    /// load/error イベントを送出済み(またはスケジュール済み)の link 要素
    pub loaded_links: HashSet<NodeId>,
}

impl Default for AsyncState {
    fn default() -> Self {
        let (tx, rx) = channel();
        Self {
            http: None,
            cookies: None,
            tx,
            rx,
            pending: HashMap::new(),
            next_id: 0,
            in_flight: 0,
            waker: Arc::new(Mutex::new(None)),
            executed_scripts: HashSet::new(),
            navigation: None,
            navigation_hook: None,
            message_hook: None,
            preloaded_modules: HashMap::new(),
            loaded_links: HashSet::new(),
        }
    }
}

fn wake(waker: &Arc<Mutex<Option<Waker>>>) {
    if let Some(waker) = waker.lock().unwrap().as_ref() {
        waker.wake_by_ref();
    }
}

/// ネイティブ関数を登録する
pub(crate) fn register(context: &mut Context) {
    register_global_fn(context, "__blitz_fetch_async", 5, fetch_async);
    register_global_fn(context, "__blitz_cookie_get", 0, cookie_get);
    register_global_fn(context, "__blitz_cookie_set", 1, cookie_set);
    register_global_fn(context, "__blitz_random_bytes", 1, random_bytes);
    register_global_fn(context, "__blitz_get_listeners", 2, get_listeners);
    register_global_fn(context, "__blitz_event_proto", 0, event_proto);
    register_global_fn(context, "__blitz_async_pending", 0, async_pending);
    register_global_fn(context, "__blitz_current_script", 0, current_script);
    register_global_fn(context, "__blitz_navigate", 5, navigate);
    register_global_fn(context, "__blitz_digest", 2, digest);
    register_global_fn(context, "__blitz_hmac", 3, hmac_sign);
}

fn bytes_arg(value: Option<&JsValue>, context: &mut Context) -> JsResult<Vec<u8>> {
    let values = js_array_to_vec(value.unwrap_or(&JsValue::undefined()), context)?;
    let mut bytes = Vec::with_capacity(values.len());
    for v in values {
        bytes.push(v.to_number(context)? as u8);
    }
    Ok(bytes)
}

fn bytes_to_js(bytes: &[u8], context: &mut Context) -> JsValue {
    JsArray::from_iter(bytes.iter().map(|b| JsValue::from(*b as i32)), context).into()
}

/// `__blitz_digest(algorithm, bytes[])`: SHA-1 / SHA-256 / SHA-384 / SHA-512(crypto.subtle.digest 用)
fn digest(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    use sha2::Digest as _;
    let algo = to_rust_string(args.first().unwrap_or(&JsValue::undefined()), context)?
        .to_ascii_uppercase()
        .replace('-', "");
    let data = bytes_arg(args.get(1), context)?;
    let out: Vec<u8> = match algo.as_str() {
        "SHA1" => sha1::Sha1::digest(&data).to_vec(),
        "SHA256" => sha2::Sha256::digest(&data).to_vec(),
        "SHA384" => sha2::Sha384::digest(&data).to_vec(),
        "SHA512" => sha2::Sha512::digest(&data).to_vec(),
        other => {
            return Err(JsNativeError::error()
                .with_message(format!("unsupported digest algorithm {other}"))
                .into());
        }
    };
    Ok(bytes_to_js(&out, context))
}

/// `__blitz_hmac(hash, key[], data[])`: HMAC(crypto.subtle.sign 用)
fn hmac_sign(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    use hmac::{Hmac, Mac};
    let algo = to_rust_string(args.first().unwrap_or(&JsValue::undefined()), context)?
        .to_ascii_uppercase()
        .replace('-', "");
    let key = bytes_arg(args.get(1), context)?;
    let data = bytes_arg(args.get(2), context)?;
    let out: Vec<u8> = match algo.as_str() {
        "SHA1" => {
            let mut m = Hmac::<sha1::Sha1>::new_from_slice(&key).map_err(|e| JsNativeError::error().with_message(e.to_string()))?;
            m.update(&data);
            m.finalize().into_bytes().to_vec()
        }
        "SHA256" => {
            let mut m = Hmac::<sha2::Sha256>::new_from_slice(&key).map_err(|e| JsNativeError::error().with_message(e.to_string()))?;
            m.update(&data);
            m.finalize().into_bytes().to_vec()
        }
        "SHA512" => {
            let mut m = Hmac::<sha2::Sha512>::new_from_slice(&key).map_err(|e| JsNativeError::error().with_message(e.to_string()))?;
            m.update(&data);
            m.finalize().into_bytes().to_vec()
        }
        other => {
            return Err(JsNativeError::error()
                .with_message(format!("unsupported HMAC hash {other}"))
                .into());
        }
    };
    Ok(bytes_to_js(&out, context))
}

/// `__blitz_navigate(url, method, body, contentType, replace)`
fn navigate(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ctx = dom_ctx(context)?;
    let input = to_rust_string(args.first().unwrap_or(&JsValue::undefined()), context)?;
    let Some(url) = resolve_url(&ctx, &input) else {
        return Err(JsNativeError::typ()
            .with_message(format!("navigate: invalid URL {input}"))
            .into());
    };
    let method = match args.get(1) {
        Some(v) if !v.is_null_or_undefined() => to_rust_string(v, context)?.to_ascii_uppercase(),
        _ => "GET".to_string(),
    };
    let body = match args.get(2) {
        Some(v) if !v.is_null_or_undefined() => Some(to_rust_string(v, context)?.into_bytes()),
        _ => None,
    };
    let content_type = match args.get(3) {
        Some(v) if !v.is_null_or_undefined() => Some(to_rust_string(v, context)?),
        _ => None,
    };
    let replace = args.get(4).is_some_and(|v| v.to_boolean());
    log::info!(target: "sunameri_net", "navigate {method} {url}");
    let nav = PendingNavigation {
        url,
        method,
        body,
        content_type,
        replace,
    };
    let hook = ctx.state.borrow().r#async.navigation_hook.clone();
    if let Some(hook) = hook {
        hook(nav);
        return Ok(JsValue::undefined());
    }
    let waker = {
        let mut state = ctx.state.borrow_mut();
        state.r#async.navigation = Some(nav);
        Arc::clone(&state.r#async.waker)
    };
    wake(&waker);
    Ok(JsValue::undefined())
}

/// `document.currentScript`
fn current_script(_: &JsValue, _: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ctx = dom_ctx(context)?;
    let id = ctx.state.borrow().current_script;
    Ok(match id {
        Some(id) => crate::dom::node_wrapper(&ctx, id, context).into(),
        None => JsValue::null(),
    })
}

fn resolve_url(ctx: &DomCtx, input: &str) -> Option<Url> {
    let base = ctx
        .state
        .borrow()
        .base_url
        .clone()
        .unwrap_or_else(|| ctx.doc.borrow().base_url().clone());
    base.join(input).ok()
}

fn js_array_to_vec(value: &JsValue, context: &mut Context) -> JsResult<Vec<JsValue>> {
    let Some(obj) = value.as_object() else {
        return Ok(Vec::new());
    };
    let array = JsArray::from_object(obj.clone())?;
    let len = array.length(context)?;
    let mut out = Vec::with_capacity(len as usize);
    for i in 0..len {
        out.push(array.get(i, context)?);
    }
    Ok(out)
}

/// `__blitz_fetch_async(url, method, [[name, value], ...], body, followRedirects)`
///
/// `body` は null、文字列(UTF-8)、または数値配列(バイト列)。
/// `[status, statusText, url, [[name, value], ...], Uint8Array, redirected]` で解決される
/// Promise を返す。ネットワークエラーは TypeError で拒否される。
fn fetch_async(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ctx = dom_ctx(context)?;
    let input = to_rust_string(args.first().unwrap_or(&JsValue::undefined()), context)?;
    let method = match args.get(1) {
        Some(v) if !v.is_null_or_undefined() => to_rust_string(v, context)?.to_ascii_uppercase(),
        _ => "GET".to_string(),
    };
    let mut headers = Vec::new();
    for pair in js_array_to_vec(args.get(2).unwrap_or(&JsValue::undefined()), context)? {
        let pair = js_array_to_vec(&pair, context)?;
        if pair.len() == 2 {
            headers.push((
                to_rust_string(&pair[0], context)?,
                to_rust_string(&pair[1], context)?,
            ));
        }
    }
    let body = match args.get(3) {
        None => None,
        Some(v) if v.is_null_or_undefined() => None,
        Some(v) if v.is_string() => Some(to_rust_string(v, context)?.into_bytes()),
        Some(v) => {
            let values = js_array_to_vec(v, context)?;
            let mut bytes = Vec::with_capacity(values.len());
            for value in values {
                bytes.push(value.to_number(context)? as u8);
            }
            Some(bytes)
        }
    };
    let follow_redirects = match args.get(4) {
        Some(v) if !v.is_undefined() => v.to_boolean(),
        _ => true,
    };

    let (promise, resolvers) = JsPromise::new_pending(context);

    let Some(url) = resolve_url(&ctx, &input) else {
        let err: JsValue = JsNativeError::typ()
            .with_message(format!("Failed to parse URL from {input}"))
            .into_opaque(context)
            .into();
        resolvers.reject.call(&JsValue::undefined(), &[err], context)?;
        return Ok(promise.into());
    };

    let http = ctx.state.borrow().r#async.http.clone();
    let Some(http) = http else {
        let err: JsValue = JsNativeError::typ()
            .with_message("fetch: no HTTP fetcher is installed")
            .into_opaque(context)
            .into();
        resolvers.reject.call(&JsValue::undefined(), &[err], context)?;
        return Ok(promise.into());
    };

    let (id, tx, waker) = {
        let mut state = ctx.state.borrow_mut();
        let a = &mut state.r#async;
        a.next_id += 1;
        let id = a.next_id;
        a.pending.insert(id, resolvers);
        a.in_flight += 1;
        (id, a.tx.clone(), Arc::clone(&a.waker))
    };

    log::info!(target: "sunameri_net", "fetch {method} {url}");
    http.fetch(
        HttpRequest {
            url,
            method,
            headers,
            body,
            follow_redirects,
        },
        Box::new(move |result| {
            let _ = tx.send(AsyncDone::Fetch { id, result });
            wake(&waker);
        }),
    );

    Ok(promise.into())
}

fn response_to_js(resp: &HttpResponse, context: &mut Context) -> JsResult<JsValue> {
    let headers = JsArray::new(context)?;
    for (name, value) in &resp.headers {
        let pair = JsArray::from_iter([js_str(name), js_str(value)], context);
        headers.push(pair, context)?;
    }
    let body = JsUint8Array::from_iter(resp.body.iter().copied(), context)?;
    Ok(JsArray::from_iter(
        [
            JsValue::from(resp.status as i32),
            js_str(&resp.status_text),
            js_str(&resp.url),
            headers.into(),
            body.into(),
            JsValue::from(resp.redirected),
        ],
        context,
    )
    .into())
}

fn cookie_get(_: &JsValue, _: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ctx = dom_ctx(context)?;
    let (jar, url) = {
        let state = ctx.state.borrow();
        (state.r#async.cookies.clone(), state.base_url.clone())
    };
    let (Some(jar), Some(url)) = (jar, url) else {
        return Ok(js_str(""));
    };
    Ok(js_str(&jar.get(&url)))
}

fn cookie_set(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ctx = dom_ctx(context)?;
    let value = to_rust_string(args.first().unwrap_or(&JsValue::undefined()), context)?;
    let (jar, url) = {
        let state = ctx.state.borrow();
        (state.r#async.cookies.clone(), state.base_url.clone())
    };
    if let (Some(jar), Some(url)) = (jar, url) {
        jar.set(&url, &value);
    }
    Ok(JsValue::undefined())
}

/// `__blitz_random_bytes(n)`: OS の乱数で n バイトの配列を返す
fn random_bytes(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let n = args
        .first()
        .map(|v| v.to_number(context))
        .transpose()?
        .unwrap_or(0.0)
        .clamp(0.0, 65536.0) as usize;
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf)
        .map_err(|e| JsNativeError::error().with_message(format!("getrandom: {e}")))?;
    Ok(JsArray::from_iter(buf.into_iter().map(|b| JsValue::from(b as i32)), context).into())
}

/// `__blitz_get_listeners(target, type)`: `addEventListener` で登録されたリスナを
/// `[[callback, capture, once], ...]` で返す。target がノードでなければ window 扱い。
fn get_listeners(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ctx = dom_ctx(context)?;
    let target = args.first().cloned().unwrap_or_default();
    let event_type = to_rust_string(args.get(1).unwrap_or(&JsValue::undefined()), context)?;
    let listeners: Vec<Listener> = {
        let state = ctx.state.borrow();
        match node_id_of_value(&target) {
            Some(node_id) => state
                .node_listeners
                .get(&node_id)
                .and_then(|map| map.get(&event_type))
                .cloned()
                .unwrap_or_default(),
            None => state
                .window_listeners
                .get(&event_type)
                .cloned()
                .unwrap_or_default(),
        }
    };
    let out = JsArray::new(context)?;
    for l in listeners {
        let entry = JsArray::from_iter(
            [
                l.callback.into(),
                JsValue::from(l.capture),
                JsValue::from(l.once),
            ],
            context,
        );
        out.push(entry, context)?;
    }
    Ok(out.into())
}

/// ネイティブイベントのプロトタイプ(JS 側で `Event` コンストラクタに繋ぐ)
fn event_proto(_: &JsValue, _: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ctx = dom_ctx(context)?;
    let proto = ctx.state.borrow().protos().event.clone();
    Ok(proto.into())
}

fn async_pending(_: &JsValue, _: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let ctx = dom_ctx(context)?;
    let n = ctx.state.borrow().r#async.in_flight;
    Ok(JsValue::from(n as i32))
}

/// 完了した非同期処理を処理する。何か処理したら true。
pub(crate) fn drain(runtime: &mut ScriptRuntime, deadline: Option<std::time::Instant>) -> (bool, bool) {
    let mut ran = false;
    loop {
        // 時間予算を使い切ったら残りは次の poll に回す(UI を止めない)
        if ran && deadline.is_some_and(|d| std::time::Instant::now() >= d) {
            return (ran, true);
        }
        let done = runtime.ctx.state.borrow().r#async.rx.try_recv();
        let Ok(done) = done else { break };
        ran = true;
        {
            let mut state = runtime.ctx.state.borrow_mut();
            state.r#async.in_flight = state.r#async.in_flight.saturating_sub(1);
        }
        let trace = std::env::var_os("SUNAMERI_TRACE_PERF").is_some();
        let item_start = std::time::Instant::now();
        let item_label = if trace {
            match &done {
                AsyncDone::Fetch { .. } => "fetch continuation".to_owned(),
                AsyncDone::Script { url, .. } => format!("script {url}"),
                AsyncDone::Resource { url, .. } => format!("resource {url}"),
            }
        } else {
            String::new()
        };
        match done {
            AsyncDone::Fetch { id, result } => {
                let resolvers = runtime.ctx.state.borrow_mut().r#async.pending.remove(&id);
                let Some(resolvers) = resolvers else { continue };
                let ctx = runtime.ctx.clone();
                let context = &mut runtime.context;
                match &result {
                    Ok(resp) => log::info!(target: "sunameri_net", "fetch done {} {} ({} bytes)", resp.status, resp.url, resp.body.len()),
                    Err(e) => log::info!(target: "sunameri_net", "fetch failed: {e}"),
                }
                let outcome = match result {
                    Ok(resp) => response_to_js(&resp, context).and_then(|value| {
                        resolvers
                            .resolve
                            .call(&JsValue::undefined(), &[value], context)
                    }),
                    Err(message) => {
                        let err: JsValue = JsNativeError::typ()
                            .with_message(format!("Failed to fetch: {message}"))
                            .into_opaque(context)
                            .into();
                        resolvers.reject.call(&JsValue::undefined(), &[err], context)
                    }
                };
                if let Err(error) = outcome {
                    report_js_error(&ctx, context, "fetch", &error);
                }
                runtime.run_jobs("fetch");
            }
            AsyncDone::Script {
                node_id,
                url,
                is_module,
                result,
            } => {
                let ok = match result {
                    Ok(resp) if (200..300).contains(&resp.status) => {
                        let code = String::from_utf8_lossy(&resp.body).into_owned();
                        runtime.ctx.state.borrow_mut().current_script = Some(node_id);
                        if is_module {
                            runtime.eval_module(&code, Some(&url));
                        } else {
                            runtime.eval_classic_at(&code, url.as_str());
                        }
                        runtime.ctx.state.borrow_mut().current_script = None;
                        true
                    }
                    Ok(resp) => {
                        log::warn!("script {url}: HTTP {}", resp.status);
                        false
                    }
                    Err(message) => {
                        log::warn!("script {url}: {message}");
                        false
                    }
                };
                runtime.dispatch_simple_node_event(node_id, if ok { "load" } else { "error" }, false);
                runtime.run_jobs("script");
            }
            AsyncDone::Resource {
                node_id,
                url,
                is_module,
                result,
            } => {
                let ok = match result {
                    Ok(resp) if (200..300).contains(&resp.status) => {
                        if is_module {
                            let code = String::from_utf8_lossy(&resp.body).into_owned();
                            runtime
                                .ctx
                                .state
                                .borrow_mut()
                                .r#async
                                .preloaded_modules
                                .insert(url, code);
                        }
                        true
                    }
                    Ok(resp) => {
                        log::warn!("link {url}: HTTP {}", resp.status);
                        false
                    }
                    Err(message) => {
                        log::warn!("link {url}: {message}");
                        false
                    }
                };
                runtime.dispatch_simple_node_event(node_id, if ok { "load" } else { "error" }, false);
                runtime.run_jobs("link");
            }
        }
        if trace && item_start.elapsed().as_millis() >= 50 {
            eprintln!("[perf] async item took {} ms: {}", item_start.elapsed().as_millis(), &item_label[..item_label.len().min(120)]);
        }
    }
    (ran, false)
}

/// 挿入された `<link>` 要素の取得を開始する(完了時に load/error イベントを送出する)
fn start_link_load(ctx: &DomCtx, node_id: NodeId, href: &str, rel: &str, context: &mut Context) {
    let _ = context;
    let Some(url) = resolve_url(ctx, href) else { return };
    let is_module = rel == "modulepreload";
    let (http, tx, waker) = {
        let mut state = ctx.state.borrow_mut();
        if !state.r#async.loaded_links.insert(node_id) {
            return;
        }
        state.r#async.in_flight += 1;
        (
            state.r#async.http.clone(),
            state.r#async.tx.clone(),
            Arc::clone(&state.r#async.waker),
        )
    };
    log::info!(target: "sunameri_net", "link[{rel}] {url}");
    let Some(http) = http else {
        // フェッチャが無ければ即座に load 扱いにする
        let _ = tx.send(AsyncDone::Resource {
            node_id,
            url: url.clone(),
            is_module: false,
            result: Ok(HttpResponse {
                status: 200,
                status_text: "OK".into(),
                url: url.to_string(),
                headers: Vec::new(),
                body: Vec::new(),
                redirected: false,
            }),
        });
        wake(&waker);
        return;
    };
    let request = HttpRequest {
        url: url.clone(),
        method: "GET".into(),
        headers: Vec::new(),
        body: None,
        follow_redirects: true,
    };
    http.fetch(
        request,
        Box::new(move |result| {
            let _ = tx.send(AsyncDone::Resource {
                node_id,
                url,
                is_module,
                result,
            });
            wake(&waker);
        }),
    );
}

/// DOM にノードが挿入された後に呼ぶ。挿入された部分木に含まれる、まだ実行していない
/// `<script>` を実行(インライン)または取得して実行(src)する。
pub(crate) fn on_nodes_inserted(ctx: &DomCtx, node_ids: &[NodeId], context: &mut Context) {
    struct Found {
        id: NodeId,
        src: Option<String>,
        text: String,
        is_module: bool,
    }
    let mut scripts = Vec::new();
    let mut links: Vec<(NodeId, String, String)> = Vec::new();
    {
        let doc = ctx.doc.borrow();
        let mut stack: Vec<NodeId> = node_ids.iter().rev().copied().collect();
        while let Some(id) = stack.pop() {
            let Some(node) = doc.get_node(id) else { continue };
            if let Some(element) = node.element_data() {
                if element.name.local == blitz_dom::local_name!("link") && node.flags.is_in_document() {
                    let rel = element
                        .attr(blitz_dom::local_name!("rel"))
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase();
                    if matches!(rel.as_str(), "modulepreload" | "preload" | "prefetch" | "stylesheet")
                        && let Some(href) = element.attr(blitz_dom::local_name!("href"))
                    {
                        links.push((id, href.to_string(), rel));
                    }
                    continue;
                }
                if element.name.local == blitz_dom::local_name!("script") {
                    if !node.flags.is_in_document() {
                        continue;
                    }
                    let script_type = element
                        .attr(blitz_dom::local_name!("type"))
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase();
                    if matches!(
                        script_type.as_str(),
                        "" | "text/javascript" | "application/javascript" | "module"
                    ) {
                        scripts.push(Found {
                            id,
                            src: element
                                .attr(blitz_dom::local_name!("src"))
                                .map(str::to_string),
                            text: node.text_content(),
                            is_module: script_type == "module",
                        });
                    }
                    continue;
                }
            }
            stack.extend(node.children.iter().rev().copied());
        }
    }

    for (id, href, rel) in links {
        start_link_load(ctx, id, &href, &rel, context);
    }

    for script in scripts {
        if !ctx
            .state
            .borrow_mut()
            .r#async
            .executed_scripts
            .insert(script.id)
        {
            continue;
        }
        match script.src {
            None => {
                if script.text.trim().is_empty() {
                    continue;
                }
                if script.is_module {
                    log::warn!("dynamic inline module scripts are not supported yet");
                    continue;
                }
                ctx.state.borrow_mut().current_script = Some(script.id);
                if let Err(error) = context.eval(Source::from_bytes(script.text.as_bytes())) {
                    report_js_error(ctx, context, "<dynamic script>", &error);
                }
                ctx.state.borrow_mut().current_script = None;
            }
            Some(src) => {
                let Some(url) = resolve_url(ctx, &src) else {
                    log::warn!("dynamic script: cannot resolve {src}");
                    continue;
                };
                let (http, sync_fetcher, tx, waker) = {
                    let mut state = ctx.state.borrow_mut();
                    state.r#async.in_flight += 1;
                    (
                        state.r#async.http.clone(),
                        state.fetcher.clone(),
                        state.r#async.tx.clone(),
                        Arc::clone(&state.r#async.waker),
                    )
                };
                let node_id = script.id;
                let is_module = script.is_module;
                log::info!(target: "sunameri_net", "script {url}");
                if matches!(url.scheme(), "file" | "data") || http.is_none() {
                    // 同期フェッチャ(file:/data:、または事前取得済みのスクリプト)
                    let result = match sync_fetcher {
                        Some(fetcher) => fetcher
                            .borrow()
                            .fetch(&url)
                            .map(|text| HttpResponse {
                                status: 200,
                                status_text: "OK".into(),
                                url: url.to_string(),
                                headers: Vec::new(),
                                body: text.into_bytes(),
                                redirected: false,
                            })
                            .map_err(|e| e.to_string()),
                        None => Err("no fetcher".to_string()),
                    };
                    let _ = tx.send(AsyncDone::Script {
                        node_id,
                        url,
                        is_module,
                        result,
                    });
                    wake(&waker);
                } else if let Some(http) = http {
                    let request = HttpRequest {
                        url: url.clone(),
                        method: "GET".into(),
                        headers: Vec::new(),
                        body: None,
                        follow_redirects: true,
                    };
                    http.fetch(
                        request,
                        Box::new(move |result| {
                            let _ = tx.send(AsyncDone::Script {
                                node_id,
                                url,
                                is_module,
                                result,
                            });
                            wake(&waker);
                        }),
                    );
                }
            }
        }
    }
}

impl ScriptRuntime {
    /// 取得したクラシックスクリプトを、URL をソース名にして評価する
    pub(crate) fn eval_classic_at(&mut self, code: &str, url: &str) {
        let source = Source::from_reader(code.as_bytes(), Some(Path::new(url)));
        if let Err(error) = self.context.eval(source) {
            report_js_error(&self.ctx, &mut self.context, url, &error);
        }
    }
}

#[allow(dead_code)]
fn _assert_send() {
    fn is_send<T: Send>() {}
    is_send::<Sender<AsyncDone>>();
    let _ = JsString::from("");
}
