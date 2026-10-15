# sunameri 開発計画

最終更新: 2026-10-14

## ゴール

- Rust 製の省メモリ Web ブラウザ。
- 対応環境: macOS(開発・当面の動作確認)と armhf Linux(本番ターゲットは NetWalker PC-Z1)。
- 最終目標: X(Twitter)の **タイムライン表示と投稿** ができること。

## ターゲット端末: SHARP NetWalker PC-Z1

| 項目 | 値 | 設計への影響 |
|---|---|---|
| CPU | Freescale i.MX515(Cortex-A8、800MHz、シングルコア、NEON) | JS 実行は純粋なインタプリタになり、X の数 MB のバンドルは数十秒〜分単位かかる見込み |
| RAM | 512MB 固定 | OS 込みなので、ブラウザは **常駐 150〜200MB** を目標に置く |
| ストレージ | 4GB(ユーザー領域約 2GB) | ディスクキャッシュは上限を小さく(数十 MB) |
| 画面 | 1024×600、16bit カラー | フレームバッファは小さい。CPU 描画で十分 |
| GPU | i.MX51 内蔵(オープンなドライバ無し) | GPU 描画は前提にしない。vello_cpu + softbuffer |
| OS | 自作の最新 Linux 移植(未完成) | ターゲットは `armv7-unknown-linux-gnueabihf`。Debian armhf 基準(ARMv7 + VFPv3)で OK |

## 方針: Blitz を土台にする

Blitz(DioxusLabs)は html5ever + stylo + taffy + parley を統合した Rust 製 HTML/CSS エンジン。
2026-10 時点で 0.3.0-beta、Wikipedia や旧 Reddit が描画できる。

重要な発見: Blitz 本体に **blitz-vibey-script**(Boa エンジンによる JavaScript 実行、DOM/イベント/タイマー/rAF/getComputedStyle 等)が
追加され、活発に開発中(2026-10-13 にもコミット)。Preact の TodoMVC が動く段階。crates.io 未公開なので git 依存で使う。

これにより「JS エンジンと DOM バインディングをゼロから書く」工程が省け、
我々の実装範囲は **X が必要とする Web API の追加、ブラウザシェル、省メモリ化、armhf 対応** に絞れる。

### 構成

| 層 | 採用 |
|---|---|
| HTML / CSS / レイアウト / テキスト | blitz-dom, blitz-html(stylo, taffy, parley) |
| JavaScript | blitz-vibey-script(Boa 0.22、純 Rust) |
| 描画 | anyrender_vello_cpu + softbuffer(CPU) |
| ウィンドウ | blitz-shell(winit) |
| ネットワーク | blitz-net(reqwest、HTTP/2、Cookie) |

### JS エンジンについて

Boa は純 Rust でクロスビルドが容易だが、速度は QuickJS の数分の一。
vibey-script は Boa に密結合(runtime.rs が約 95KB)なので、エンジン差し替えは高コスト。
まず Boa で進め、NetWalker 実機で許容できなければ以下を検討する:

1. Boa 自体の最適化に貢献する(アロケーション削減、バイトコード改善)。
2. vibey-script を QuickJS-NG(rquickjs、armv7 は `bindgen` feature)へ移植する。

## フェーズ

### Phase 0: 基盤(進行中)

- [x] Cargo workspace、Blitz git 依存(コミット e72650a6 固定)
- [x] 最小シェル `crates/sunameri`: URL 取得 → ScriptDocument → CPU 描画
- [x] `scripts/memcheck.sh`: RSS 計測
- [x] `--screenshot` ヘッドレス描画モード(ウィンドウ無しで PNG 出力。自動テストの土台)
- [x] macOS でビルドと表示確認(example.com、Wikipedia 日本語ページが描画できた)
- [x] `cargo check --target armv7-unknown-linux-gnueabihf`: Rust 側は通る。失敗は C 依存の 2 つだけ
  - `openssl-sys`(blitz-net が reqwest の native-tls を使う)→ Phase 4 で rustls へ切替
  - `yeslogic-fontconfig-sys`(parley の system-fonts が Linux で fontconfig を使う)→ 同梱フォント方式を検討
- [x] 計測基準値(2026-10-14、debug ビルド、1024×600、JS 有効)

| ページ | 最大 RSS | 備考 |
|---|---|---|
| example.com(ヘッドレス) | 49MB | |
| ja.wikipedia.org スナメリ(ヘッドレス) | 71MB | |
| example.com(ウィンドウ表示) | 131MB | winit + softbuffer + macOS のウィンドウサーバ分 |

- 最初に見つかった JS の不足 API: `Element.insertAdjacentHTML`(example.com の s.js が失敗)。
  Wikipedia のインラインスクリプトも `cannot convert 'null' or 'undefined' to object` で停止。Phase 2 の着手点。

### Phase 1: ブラウザシェル(進行中)

- [x] シェル自体を HTML(crates/sunameri/assets/shell.html)で書き、自前エンジンで描画する。
  ツールバー(戻る/進む/再読み込み/URL バー/読み込み中表示)の JS は `__blitz_send_message` で
  Rust にコマンドを送り、Rust は `sunameriShell.*` を eval して UI を更新する(crates/sunameri/src/shell.rs)。
- [x] ページはシェルの `<iframe id="page">` のサブドキュメント(JS 付き ScriptDocument)として差し替える。
  ページ内のリンク・フォーム送信・JS からのナビゲーションはイベント経由でシェルが受け取り、履歴を管理する。
- [x] 再描画要求はイベントループ経由にする(tokio スレッドから winit を直接呼ぶと macOS でデッドロック)。
- [x] ショートカット(Rust 側): Cmd/Ctrl+L で URL バー、Cmd/Ctrl+R 再読み込み、Alt+←/→ と Cmd/Ctrl+[ ] で戻る/進む。
- [x] デバッグ用 `SUNAMERI_SHELL_SCRIPT=file.js`(最初のページ読み込み後にシェル側で評価)で
  遷移・戻る・進むを自動確認した。マウス/キーボード操作の実機確認はユーザーに依頼。
- [ ] ページ読み込み中は ES モジュールの取得でメインスレッドが止まる(UI が数秒固まる)。
  独自 JobExecutor で非同期化するまでの既知の制限。
- [x] Cookie の永続化と取り込み(2026-10-15)。期限付きの Cookie を終了時・ウィンドウを閉じるとき・
  10 秒ごとに `~/Library/Application Support/sunameri/cookies.json`(Linux は `$XDG_DATA_HOME/sunameri`、
  `SUNAMERI_DATA_DIR` で変更)へ保存し、起動時に読み込む。`--no-cookies` で無効化、`--cookies-file` で場所指定。
  取り込みは `--import-cookies cookies.txt`(Netscape 形式、`#HttpOnly_` 対応)と
  `--set-cookie 'name=value; Domain=.x.com; Path=/; Secure'`(期限が無ければ 1 年)。URL を省略すると
  取り込んで保存した後に終了する。
  例: `sunameri --set-cookie 'auth_token=...; Domain=.x.com; Path=/; Secure; HttpOnly' --set-cookie 'ct0=...; Domain=.x.com; Path=/; Secure'`
  の後 `sunameri https://x.com/home`。ct0 は JS が document.cookie から読むので HttpOnly にしない。
- [ ] タブ、ブックマーク、画像キャッシュ上限、同梱フォント。

### Phase 2: JS 対応を React アプリ水準へ(進行中)

blitz-vibey-script を `crates/blitz-vibey-script` にベンダリングし(由来は UPSTREAM.md)、以下を追加した。

- [x] `crates/sunameri-net`: reqwest + rustls(ring)、Cookie ジャー共有、ステータス/ヘッダ付き応答、
  blitz-dom 向け NetProvider。blitz-net(native-tls)は使わない。
- [x] 非同期 HTTP フック(`HttpFetcher`)と `document.cookie` フック(`CookieJar`)。
  完了はチャネルで通知し `poll()` 内で Promise を解決する(src/http.rs)。
- [x] JS 側(src/sunameri_fetch.js): fetch / Request / Response / Headers / AbortController /
  Blob / File / FormData / URLSearchParams / Streams / XMLHttpRequest。
- [x] JS 側(src/sunameri_polyfills.js): 構築可能な Event 群と dispatchEvent、EventTarget、performance、
  Storage、crypto、matchMedia、Intersection/Resize/MutationObserver、history(popstate 付き)、
  navigator / screen / window の各種、document の各種、DOMParser、Range、TreeWalker、
  Element の属性反映プロパティ、ライブな attributes(NamedNodeMap)など。
  API 調査ページ(tests/pages/probe.html)で 345 項目中の不足が 230 → 35 に減った。
- [x] 動的 `<script>` 挿入(src / inline / module)の実行と load/error イベント。
- [x] ES モジュールの HTTP 読み込み(`import` / `import()`)と `import.meta.url`。
  Boa の SimpleJobExecutor は非同期ジョブが残る間ビジーループするため、モジュール取得は
  ブロッキングで行っている(改善案: 独自 JobExecutor)。
- [x] `document.currentScript`、module / defer / async スクリプトの実行順序。
- [x] 未処理 Promise 拒否の報告(HostHooks)。Boa は既定で黙って捨てるためデバッグに必須。
- [x] Boa の実行上限(ループ回数 5000 万、再帰 2 万)と大きなスタック(macOS はリンカ、ヘッドレスはスレッド)。
- [x] Intl(`boa_engine/intl_bundled`)。
- [x] 修正した vibey-script の不具合: SVG の `viewBox` など大文字を含む属性名が removeAttribute で
  消えず React の後始末が無限ループする(属性名の小文字化を HTML 要素だけに限定)、
  `<template>` の innerHTML が content に入らない、getComputedStyle の stylo debug_assert。
- [x] React 18 の Todo アプリが動く(tests/pages/react-todo.html)。
- [x] `<link rel="modulepreload|preload|stylesheet">` の load/error イベント(Vite の preload ヘルパーが待つ)
  と、先読みしたモジュールソースのキャッシュ。
- [x] Web Animations API の最小実装(`element.animate()`、`currentTime`、cubic-bezier、色と transform の補間)と
  `getComputedStyle` へのアニメーション値の反映。X の API 署名(x-client-transaction-id)はこれに依存していた。
- [x] Referer / Origin ヘッダの自動付与、`SUNAMERI_TRACE_NET` / `SUNAMERI_TRACE_NATIVE` /
  `SUNAMERI_TRACE_TYPEERROR` / `SUNAMERI_PRELUDE` によるデバッグ手段。
- [x] X(x.com)の読み込み: ログアウト状態のランディングページ → フォーム送信で
  `/i/jf/onboarding/web?mode=login` へ遷移 → React 19 がログインモーダルを描画し、
  ユーザー名入力と「Continue」で `jf.x.com/onboarding/web/actions/begin_login` が呼ばれるところまで動く
  (tests/x-login-step1.js, step2.js)。API 署名も検証を通る。
- [ ] 実アカウントでのログインとタイムライン表示は、ウィンドウモードでユーザー自身が操作して確認する
  (Phase 1 のシェルとナビゲーションの差し替えが必要)。
- [ ] 非同期モジュール読み込み(独自 JobExecutor)、WebSocket、IndexedDB、Worker は未着手。

計測(2026-10-14、release ビルド、x.com ログインページ、settle 12 秒): 最大 RSS 約 400MB。
Phase 4 で削減する(Intl データ、Boa のヒープ、画像キャッシュが主因と推定)。

マイルストーン: React の TodoMVC(達成)→ X のログイン画面が操作できる → タイムライン。

### Phase 3: X 向けの機能

- CORS、WebSocket、Web Crypto の一部、Service Worker は非対応のまま UA で回避(Cookie 永続化は Phase 1 で実装済み)。
- ログインは X 側のリスク判定で「We've temporarily limited your login」になることがある(2026-10-15)。
  この判定を通すためのクライアント調整はしない。代わりに普段のブラウザのセッション Cookie を取り込んで
  タイムラインへ進める。
- 入力周り: contenteditable(X の投稿欄は Draft.js 系で contenteditable を使う)、IME、クリップボード。
- マイルストーン: 公開プロフィールの閲覧 → ログイン → タイムライン(2026-10-15 到達。取り込んだ
  セッション Cookie で /home を開き、ヘッドレスでおすすめタイムラインが描画された)→ 投稿。
- 到達のために直したこと: `<noscript>` を JS 有効時は生テキストにする(vendor/blitz-html、X は noscript 内の
  style で react-root を隠す)、`document.title` の setter、`Date.parse` の旧来書式(created_at)。
- 残課題: 画像(アバター、メディア)とナビの SVG アイコンが描画されない、ウィンドウモードでの操作確認。

### Phase 4: 省メモリ化と armhf

- クロスビルド環境(cross または cargo-zigbuild)、TLS を rustls に切替(OpenSSL 依存を除く)。
- stylo のスタイル共有、DOM の文字列インターニング、非表示タブ破棄、アロケータ選定。
- NetWalker 実機で RSS と描画時間を計測し、目標(常駐 200MB 以下)へ追い込む。

## 想定するリスク

- X は JS 無しでは一切表示されず、未知の UA をブロックすることがある。UA 偽装が必要。
- X の JS バンドルは Boa インタプリタでは重い。NetWalker ではログインまで数分かかる可能性がある。
- Blitz は beta で API が頻繫に変わる。コミット固定で追従タイミングを制御する。
- vibey-script は上流が Boa 前提で急速に変化中。差分が大きくならないよう、追加機能は上流に還元する。
