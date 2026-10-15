//! ウィンドウモードのブラウザシェル。
//!
//! シェル自体が HTML(assets/shell.html)で、自前エンジンで描画する。ツールバーの JS は
//! `__blitz_send_message` で Rust にコマンドを送り、Rust は `sunameriShell.*` を eval して
//! URL バーなどを更新する。ページはシェルの `<iframe id="page">` のサブドキュメントとして
//! 差し替える。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use blitz_dom::NodeId;
use blitz_shell::{BlitzApplication, BlitzShellEvent, BlitzShellProxy, View, WindowConfig};
use blitz_traits::navigation::{NavigationOptions, NavigationProvider};
use blitz_traits::net::NetWaker;
use blitz_traits::shell::{ClipboardError, ShellProvider};
use winit::cursor::CursorIcon;
use blitz_vibey_script::{PendingNavigation, ScriptDocument};
use url::Url;
use winit::application::ApplicationHandler;
use winit::event::{StartCause, WindowEvent};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::event_loop::ActiveEventLoop;
#[cfg(target_os = "macos")]
use winit::platform::macos::ApplicationHandlerExtMacOS;
use winit::window::WindowId;

use crate::{Loader, NavRequest, WindowRenderer, report};

/// シェル HTML(ビルド時に埋め込む)
pub const SHELL_HTML: &str = include_str!("../assets/shell.html");

/// シェル内部のイベント(BlitzShellEvent::Embedder で運ぶ)
pub enum ShellEvent {
    /// シェル UI(JS)からのコマンド: "navigate <url>", "back", "forward", "reload"
    Message(String),
    /// ページの JS が要求したナビゲーション
    JsNavigate(PendingNavigation),
    /// ドキュメントの取得が完了した
    Loaded {
        generation: u64,
        url: String,
        status: u16,
        html: String,
    },
    LoadFailed {
        generation: u64,
        url: String,
        error: String,
    },
}

/// ShellEvent を BlitzShellEvent::Embedder に包む(Arc<dyn Any> から所有権を取り出すため Mutex<Option> に入れる)
pub fn embed(event: ShellEvent) -> BlitzShellEvent {
    BlitzShellEvent::embedder_event(Mutex::new(Some(event)))
}

/// 再描画要求をイベントループ経由で行う ShellProvider / NetWaker。
///
/// winit の `request_redraw` を別スレッド(tokio ワーカー)から呼ぶと macOS ではメインスレッドを
/// 同期的に待つため、メインスレッドがモジュール取得などでブロック中だとデッドロックする。
/// 代わりにプロキシへイベントを送る。
pub struct ProxyRedraw {
    pub proxy: BlitzShellProxy,
    /// ウィンドウのルート(シェル)ドキュメントの id。生成後に設定する
    pub root_doc_id: Arc<AtomicUsize>,
    /// 再描画以外の操作(カーソル、タイトル、IME、クリップボード)の委譲先
    pub delegate: Option<Arc<dyn ShellProvider>>,
    /// `<title>` の変更をウィンドウへ転送するか。ページ用のプロバイダは false にし、
    /// シェルが表示中ページの title を自分で同期する(ページ内の iframe も同じプロバイダを
    /// 共有するため、転送すると広告や Google ログインのフレームのタイトルに化ける)
    pub forward_title: bool,
}

impl ProxyRedraw {
    fn send_redraw(&self) {
        let doc_id = self.root_doc_id.load(Ordering::SeqCst);
        self.proxy.send_event(BlitzShellEvent::RequestRedraw { doc_id });
    }
}

impl NetWaker for ProxyRedraw {
    fn wake(&self, _doc_id: usize) {
        self.send_redraw();
    }
}

impl ShellProvider for ProxyRedraw {
    fn request_redraw(&self) {
        self.send_redraw();
    }
    fn set_cursor(&self, icon: Option<CursorIcon>) {
        if let Some(d) = &self.delegate {
            d.set_cursor(icon);
        }
    }
    fn set_window_title(&self, title: String) {
        if !self.forward_title {
            return;
        }
        if let Some(d) = &self.delegate {
            d.set_window_title(title);
        }
    }
    fn set_ime_enabled(&self, is_enabled: bool) {
        if let Some(d) = &self.delegate {
            d.set_ime_enabled(is_enabled);
        }
    }
    fn set_ime_cursor_area(&self, x: f32, y: f32, width: f32, height: f32) {
        if let Some(d) = &self.delegate {
            d.set_ime_cursor_area(x, y, width, height);
        }
    }
    fn get_clipboard_text(&self) -> Result<String, ClipboardError> {
        match &self.delegate {
            Some(d) => d.get_clipboard_text(),
            None => Err(ClipboardError),
        }
    }
    fn set_clipboard_text(&self, text: String) -> Result<(), ClipboardError> {
        match &self.delegate {
            Some(d) => d.set_clipboard_text(text),
            None => Err(ClipboardError),
        }
    }
}

/// ページ内のリンククリックやフォーム送信を受け取ってイベントループへ送る
pub struct ProxyNavigation(pub BlitzShellProxy);

impl NavigationProvider for ProxyNavigation {
    fn navigate_to(&self, options: NavigationOptions) {
        self.0
            .send_event(BlitzShellEvent::Navigate(Box::new(options)));
    }
}

pub struct ShellApplication {
    inner: BlitzApplication<WindowRenderer>,
    loader: Loader,
    proxy: BlitzShellProxy,
    history: Vec<Url>,
    /// `history` の現在位置(history が空のときは 0)
    index: usize,
    /// 読み込み世代。古い世代の完了通知は捨てる
    generation: u64,
    page_node: Option<NodeId>,
    /// ウィンドウ生成前に届いた読み込み結果
    pending_apply: Option<(String, String)>,
    /// シェルドキュメントの id(再描画イベントの宛先)
    root_doc_id: Arc<AtomicUsize>,
    modifiers: winit::event::Modifiers,
    shell_script_done: bool,
    /// 最後にウィンドウへ設定したページタイトル
    last_title: Option<String>,
    /// Cookie の保存先(None なら保存しない)
    cookies_file: Option<std::path::PathBuf>,
    /// 最後に Cookie を保存した時刻(変更の有無に関わらず一定間隔で確認する)
    last_cookie_save: std::time::Instant,
}

impl ShellApplication {
    pub fn new(
        proxy: BlitzShellProxy,
        event_queue: std::sync::mpsc::Receiver<BlitzShellEvent>,
        loader: Loader,
        root_doc_id: Arc<AtomicUsize>,
        cookies_file: Option<std::path::PathBuf>,
    ) -> Self {
        Self {
            inner: BlitzApplication::new(proxy.clone(), event_queue),
            loader,
            proxy,
            history: Vec::new(),
            index: 0,
            generation: 0,
            page_node: None,
            pending_apply: None,
            root_doc_id,
            modifiers: Default::default(),
            shell_script_done: false,
            last_title: None,
            cookies_file,
            last_cookie_save: std::time::Instant::now(),
        }
    }

    pub fn add_window(&mut self, window_config: WindowConfig<WindowRenderer>) {
        self.inner.add_window(window_config);
    }

    fn view(&mut self) -> Option<&mut View<WindowRenderer>> {
        self.inner.windows.values_mut().next()
    }

    /// シェル UI の JS を評価する
    fn shell_eval(&mut self, code: &str) {
        if let Some(view) = self.view() {
            view.downcast_doc_mut::<ScriptDocument>().eval(code);
        }
    }

    fn page_node(&mut self) -> Option<NodeId> {
        if self.page_node.is_none() {
            let found = {
                let view = self.view()?;
                let inner = view.doc.inner();
                inner.query_selector("#page").ok().flatten()
            };
            self.page_node = found;
        }
        self.page_node
    }

    /// 現在のページ(iframe のサブドキュメント)に対して処理する
    fn with_page<R>(&mut self, f: impl FnOnce(&mut ScriptDocument) -> R) -> Option<R> {
        let node = self.page_node()?;
        let view = self.view()?;
        let mut inner = view.doc.inner_mut();
        let sub: &mut dyn blitz_dom::Document = inner.subdoc_mut(node)?;
        let any: &mut dyn std::any::Any = sub;
        any.downcast_mut::<ScriptDocument>().map(f)
    }

    fn current_url(&self) -> Option<&Url> {
        self.history.get(self.index)
    }

    /// 新しい URL へ移動する(履歴に積む)
    pub fn navigate(&mut self, req: NavRequest) {
        // 現在位置より先の履歴を捨てて積む
        if !self.history.is_empty() {
            self.history.truncate(self.index + 1);
        }
        self.history.push(req.url.clone());
        self.index = self.history.len() - 1;
        self.start_load(req);
    }

    fn go_history(&mut self, delta: isize) {
        let next = self.index as isize + delta;
        if next < 0 || next as usize >= self.history.len() {
            return;
        }
        self.index = next as usize;
        let url = self.history[self.index].clone();
        self.start_load(NavRequest::get(url));
    }

    fn reload(&mut self) {
        if let Some(url) = self.current_url().cloned() {
            self.start_load(NavRequest::get(url));
        }
    }

    fn start_load(&mut self, req: NavRequest) {
        self.generation += 1;
        let generation = self.generation;
        eprintln!("[shell] loading {} {}", req.method, req.url);
        self.shell_eval(&format!(
            "sunameriShell.setUrl({}); sunameriShell.setLoading(true);",
            json_str(req.url.as_str())
        ));
        self.update_nav_ui();
        let net = Arc::clone(&self.loader.net);
        let proxy = self.proxy.clone();
        let url_str = req.url.to_string();
        let mut headers = Vec::new();
        if let Some(ct) = &req.content_type {
            headers.push(("content-type".to_string(), ct.clone()));
        }
        let fetch = sunameri_net::FetchRequest {
            url: req.url,
            method: req.method,
            headers,
            body: req.body,
            follow_redirects: true,
        };
        self.loader.handle.spawn(async move {
            let event = match net.fetch_full(fetch).await {
                Ok(resp) => ShellEvent::Loaded {
                    generation,
                    url: resp.url,
                    status: resp.status,
                    html: String::from_utf8_lossy(&resp.body).into_owned(),
                },
                Err(err) => ShellEvent::LoadFailed {
                    generation,
                    url: url_str,
                    error: err.to_string(),
                },
            };
            proxy.send_event(embed(event));
        });
    }

    /// 取得した HTML からページを構築して iframe に差し替える
    fn apply_loaded(&mut self, url: String, html: String) {
        let Some(node) = self.page_node() else {
            self.pending_apply = Some((url, html));
            return;
        };
        // リダイレクト後の URL を履歴に反映する
        if let Ok(parsed) = Url::parse(&url)
            && let Some(slot) = self.history.get_mut(self.index)
        {
            *slot = parsed;
        }
        self.loader.net.set_document_url(Url::parse(&url).ok());

        let delegate = self.view().map(|v| v.doc.inner().shell_provider.clone());
        let mut config = self.loader.config_for_page(url.clone());
        config.shell_provider = Some(Arc::new(ProxyRedraw {
            proxy: self.proxy.clone(),
            root_doc_id: Arc::clone(&self.root_doc_id),
            delegate,
            forward_title: false,
        }));
        self.last_title = None;
        config.navigation_provider = Some(Arc::new(ProxyNavigation(self.proxy.clone())));
        let proxy = self.proxy.clone();
        let nav_hook: Arc<dyn Fn(PendingNavigation) + Send + Sync> = Arc::new(move |nav| {
            proxy.send_event(embed(ShellEvent::JsNavigate(nav)));
        });
        let doc = self.loader.load_script_document(&html, config, Some(nav_hook));

        if let Some(view) = self.view() {
            view.doc.inner_mut().set_sub_document(node, Box::new(doc));
            view.poll();
            view.request_redraw();
        }
        self.shell_eval(&format!(
            "sunameriShell.setUrl({}); sunameriShell.setLoading(false);",
            json_str(&url)
        ));
        self.update_nav_ui();
        // デバッグ用: 最初のページ読み込み後にシェル側で評価する JS(SUNAMERI_SHELL_SCRIPT=path)
        if !self.shell_script_done {
            self.shell_script_done = true;
            if let Some(path) = std::env::var_os("SUNAMERI_SHELL_SCRIPT") {
                match std::fs::read_to_string(&path) {
                    Ok(code) => self.shell_eval(&code),
                    Err(err) => eprintln!("[shell] cannot read {}: {err}", path.to_string_lossy()),
                }
            }
        }
    }

    fn update_nav_ui(&mut self) {
        let can_back = self.index > 0;
        let can_fwd = self.index + 1 < self.history.len();
        self.shell_eval(&format!("sunameriShell.setNav({can_back}, {can_fwd});"));
    }

    fn handle_message(&mut self, msg: String) {
        let (cmd, arg) = msg.split_once(' ').unwrap_or((msg.as_str(), ""));
        match cmd {
            "navigate" => {
                let raw = arg.trim();
                let url = Url::parse(raw)
                    .or_else(|_| Url::parse(&format!("https://{raw}")))
                    .ok();
                match url {
                    Some(url) => self.navigate(NavRequest::get(url)),
                    None => eprintln!("[shell] invalid URL: {raw}"),
                }
            }
            "back" => self.go_history(-1),
            "forward" => self.go_history(1),
            "reload" => self.reload(),
            other => eprintln!("[shell] unknown command: {other}"),
        }
    }

    fn handle_shell_event(&mut self, event: ShellEvent) {
        match event {
            ShellEvent::Message(msg) => self.handle_message(msg),
            ShellEvent::JsNavigate(nav) => self.navigate(NavRequest {
                url: nav.url,
                method: nav.method,
                body: nav.body,
                content_type: nav.content_type,
            }),
            ShellEvent::Loaded {
                generation,
                url,
                status,
                html,
            } => {
                if generation != self.generation {
                    return;
                }
                eprintln!("[shell] HTTP {status} {url} ({} bytes)", html.len());
                self.apply_loaded(url, html);
            }
            ShellEvent::LoadFailed {
                generation,
                url,
                error,
            } => {
                if generation != self.generation {
                    return;
                }
                eprintln!("[shell] load failed {url}: {error}");
                let html = format!(
                    "<!doctype html><html><body style=\"font-family:sans-serif;padding:24px\"><h2>読み込みに失敗しました</h2><p>{}</p><pre>{}</pre></body></html>",
                    html_escape(&url),
                    html_escape(&error)
                );
                self.apply_loaded(url, html);
            }
        }
    }

    /// ページの JS エラーやコンソール出力を標準エラーへ流す
    fn flush_page_logs(&mut self) {
        self.with_page(|doc| report(doc));
    }

    /// ウィンドウ生成前に届いていた読み込み結果を適用する
    fn apply_pending(&mut self) {
        if self.pending_apply.is_some() && self.page_node().is_some() {
            if let Some((url, html)) = self.pending_apply.take() {
                self.apply_loaded(url, html);
            }
        }
        self.sync_title();
        self.maybe_save_cookies(false);
    }

    /// 変更があれば Cookie を保存する(`force` でなければ 10 秒に 1 回まで)
    fn maybe_save_cookies(&mut self, force: bool) {
        if !force && self.last_cookie_save.elapsed() < std::time::Duration::from_secs(10) {
            return;
        }
        self.last_cookie_save = std::time::Instant::now();
        crate::save_cookies(&self.loader.net.cookies(), self.cookies_file.as_deref());
    }

    /// 表示中ページの `<title>` をウィンドウタイトルに反映する(ページ内 iframe の title は見ない)
    fn sync_title(&mut self) {
        let title = self
            .with_page(|doc| blitz_dom::Document::inner(doc).find_title_node().map(|n| n.text_content()))
            .flatten()
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty());
        if title == self.last_title {
            return;
        }
        let shown = title.clone().unwrap_or_else(|| "sunameri".to_owned());
        if let Some(view) = self.view() {
            let provider = view.doc.inner().shell_provider.clone();
            provider.set_window_title(shown);
        }
        self.last_title = title;
    }
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '<' => out.push_str("\\u003c"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

impl ApplicationHandler for ShellApplication {
    #[cfg(target_os = "macos")]
    fn macos_handler(&mut self) -> Option<&mut dyn ApplicationHandlerExtMacOS> {
        self.inner.macos_handler()
    }

    fn resumed(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.resumed(event_loop);
    }

    fn suspended(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.suspended(event_loop);
    }

    fn can_create_surfaces(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.can_create_surfaces(event_loop);
    }

    fn destroy_surfaces(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.destroy_surfaces(event_loop);
    }

    fn new_events(&mut self, event_loop: &dyn ActiveEventLoop, cause: StartCause) {
        self.inner.new_events(event_loop, cause);
    }

    fn window_event(
        &mut self,
        event_loop: &dyn ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        if let WindowEvent::ModifiersChanged(m) = &event {
            self.modifiers = *m;
        }
        if matches!(event, WindowEvent::CloseRequested) {
            // ウィンドウを閉じるときに Cookie を保存する(main から抜けるときにも保存するが念のため)
            self.maybe_save_cookies(true);
        }
        // ブラウザ全体のショートカット(フォーカスがページ内にあっても効く)
        if let WindowEvent::KeyboardInput { event: key, .. } = &event
            && key.state.is_pressed()
            && let PhysicalKey::Code(code) = key.physical_key
        {
            let mods = self.modifiers.state();
            let primary = mods.control_key() || mods.meta_key();
            let handled = match code {
                KeyCode::KeyL if primary => {
                    self.shell_eval("sunameriShell.focusUrl();");
                    true
                }
                KeyCode::KeyR if primary => {
                    self.reload();
                    true
                }
                KeyCode::ArrowLeft if mods.alt_key() => {
                    self.go_history(-1);
                    true
                }
                KeyCode::ArrowRight if mods.alt_key() => {
                    self.go_history(1);
                    true
                }
                KeyCode::BracketLeft if primary => {
                    self.go_history(-1);
                    true
                }
                KeyCode::BracketRight if primary => {
                    self.go_history(1);
                    true
                }
                _ => false,
            };
            if handled {
                if let Some(view) = self.view() {
                    view.request_redraw();
                }
                return;
            }
        }
        let is_redraw = matches!(event, WindowEvent::RedrawRequested);
        if is_redraw && let Some(view) = self.view() {
            // JS からの強制レイアウトにも同じアニメーション時刻を使わせる
            blitz_vibey_script::set_animation_time(view.current_animation_time());
        }
        let name = if is_redraw { "redraw" } else { "window_event" };
        let t0 = std::time::Instant::now();
        self.inner.window_event(event_loop, window_id, event);
        trace_perf(name, t0);
        if is_redraw {
            trace_redraw_stats(t0);
        }
        self.apply_pending();
        self.flush_page_logs();
    }

    fn about_to_wait(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.about_to_wait(event_loop);
        self.apply_pending();
    }

    fn proxy_wake_up(&mut self, event_loop: &dyn ActiveEventLoop) {
        let t0 = std::time::Instant::now();
        let mut events = 0u32;
        while let Ok(event) = self.inner.event_queue.try_recv() {
            events += 1;
            match event {
                BlitzShellEvent::Embedder(event) => {
                    if let Some(slot) = event.downcast_ref::<Mutex<Option<ShellEvent>>>()
                        && let Some(ev) = slot.lock().unwrap().take()
                    {
                        self.handle_shell_event(ev);
                    }
                }
                BlitzShellEvent::Navigate(options) => {
                    self.navigate(NavRequest::from_options(*options));
                }
                event => self.inner.handle_blitz_shell_event(event_loop, event),
            }
        }
        if events > 0 {
            trace_perf("proxy_wake_up", t0);
        }
        self.apply_pending();
        self.flush_page_logs();
    }
}

/// SUNAMERI_TRACE_PERF: 100ms を超えたイベント処理を stderr に出す
fn trace_perf(name: &str, start: std::time::Instant) {
    if std::env::var_os("SUNAMERI_TRACE_PERF").is_none() {
        return;
    }
    let ms = start.elapsed().as_millis();
    if ms >= 100 {
        eprintln!("[perf] {name} took {ms} ms");
    }
}

/// SUNAMERI_TRACE_PERF: 1 秒ごとの再描画回数と所要時間
fn trace_redraw_stats(start: std::time::Instant) {
    if std::env::var_os("SUNAMERI_TRACE_PERF").is_none() {
        return;
    }
    thread_local! {
        static STATS: std::cell::Cell<(u32, u64, Option<std::time::Instant>)> = const { std::cell::Cell::new((0, 0, None)) };
    }
    STATS.with(|cell| {
        let (count, micros, since) = cell.get();
        let since = since.unwrap_or(start);
        let count = count + 1;
        let micros = micros + start.elapsed().as_micros() as u64;
        if since.elapsed().as_secs() >= 1 {
            eprintln!("[perf] redraws: {count} in {:.1}s, {} ms", since.elapsed().as_secs_f64(), micros / 1000);
            cell.set((0, 0, Some(std::time::Instant::now())));
        } else {
            cell.set((count, micros, Some(since)));
        }
    });
}
