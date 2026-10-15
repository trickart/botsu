# sunameri — NetWalker 向け省メモリ Web ブラウザ(X が見られるもの)

**期間**: 2026-10-14 〜 2026-10-15(2 日間、15 コミット)
**結果**: 没。X のポスト作成モーダルが開くところまで到達したが、実用速度に届く見込みが立たず中断。

このディレクトリは元リポジトリから `target/` と `.git` を除いてそのままコピーしたもの。
開発時の計画と進捗は [docs/PLAN.md](docs/PLAN.md) に残っている。

## やりたかったこと

- SHARP NetWalker PC-Z1(Cortex-A8 800MHz シングルコア、RAM 512MB、armhf)で動く Rust 製の省メモリブラウザ。
- 最終目標は **X(Twitter)のタイムライン表示と投稿**。
- 常駐メモリの目標は 150〜200MB。

## どう作ったか

JS エンジンと DOM バインディングをゼロから書く代わりに、DioxusLabs の **Blitz** を土台にした。
Blitz に追加されたばかりの **blitz-vibey-script**(Boa 0.22 による JS 実行と DOM バインディング)を
ベンダリングし、X が必要とする Web API を足していく方針。

| 層 | 採用 |
|---|---|
| HTML / CSS / レイアウト / テキスト | blitz-dom, blitz-html(html5ever, stylo, taffy, parley) |
| JavaScript | blitz-vibey-script(Boa 0.22、純 Rust)をベンダリングして拡張 |
| 描画 | anyrender_vello_cpu + softbuffer(NetWalker にはオープンな GPU ドライバが無いので CPU 描画) |
| ウィンドウ | blitz-shell(winit) |
| ネットワーク | 自前の `sunameri-net`(reqwest + rustls、Cookie ジャー共有、armhf クロスビルドのため OpenSSL を回避) |

### ディレクトリ

- `crates/sunameri`: ブラウザシェル。ツールバー自体を HTML(`assets/shell.html`)で書いて自前エンジンで描画し、
  ページは `<iframe id="page">` のサブドキュメントとして差し替える。`--screenshot` でヘッドレス描画もできる。
- `crates/sunameri-net`: reqwest + rustls のネットワーク層。`document.cookie` と共有する Cookie ジャー、
  Netscape 形式 cookies.txt の取り込み。
- `crates/blitz-vibey-script`: 上流のベンダリング。非同期 fetch、ES モジュール読み込み、動的 script、
  Web Animations API の最小実装、Selection API などを追加。JS 側のポリフィルが約 3,900 行
  (`sunameri_fetch.js`、`sunameri_polyfills.js`、`geometry.js`)。
- `vendor/`: Boa(`boa_engine`、`boa_ast`)、`blitz-paint`、`blitz-html` への独自パッチ。
  内容は各ディレクトリの `SUNAMERI_PATCHES.md` / `UPSTREAM.md` を参照。
- `tests/`: API 不足を調べる `pages/probe.html`、React 18 Todo、X ログイン操作の自動化スクリプト。
- `scripts/memcheck.sh`: RSS を 1 秒ごとに記録する。

## どこまで動いたか

1. example.com、Wikipedia 日本語ページの描画(RSS 49〜71MB、ヘッドレス)。
2. React 18 の TodoMVC。
3. X のログアウト状態ランディングページ → ログインモーダル(React 19)→ ユーザー名送信で `begin_login` が呼ばれるところまで。
   API 署名(x-client-transaction-id)も検証を通った。
4. 普段のブラウザから取り込んだセッション Cookie で `/home` を開き、おすすめタイムラインがヘッドレスで描画された。
5. ポスト作成モーダルが開く(Draft.js の編集に Selection API が必要だった)。← ここで中断。

未達のまま残ったもの: 画像と SVG アイコンの描画、ES モジュール取得の非同期化(取得中は UI が固まる)、
WebSocket / IndexedDB / Worker、ウィンドウモードでの実操作確認、armhf 実機での動作、省メモリ化。

## なぜうまくいかなかったか(本人インタビューより)

**一番の理由は速度。** X の JS バンドルを Boa で実行すると MacBook 上でもページが出るまでに非常に時間がかかり、
これが 800MHz シングルコアの NetWalker で現実的になるとは思えなかった。
計画段階でも「NetWalker ではログインまで数分かかる可能性がある」とリスクに書いていたが、
MacBook で既に遅いという事実で見込みがほぼ確定した。

**互換性の穴埋めが終わらない。** X を表示できるだけの Web API 互換性を持たせるのが大変だった。
API 調査ページで 345 項目中の不足を 230 → 35 まで減らしても、実際の X のバンドルは次々と別の箇所で止まる。
noscript の扱い、`Date.parse` の旧来書式、Boa の `this` 束縛、fixed の描画順、Selection API など、
修正の大半は「X のバンドルがたまたま踏む」ものだった。

**修正ループが遅い。** バンドル実行そのものが遅いので、1 回の修正を確認するのにも時間がかかり、
上の穴埋めがさらに重くなった。

**やめた判断は「時間・労力に対する見返りが小さい」。** モーダルが開く段階までは来たが、
この先に画像描画、非同期モジュール読み込み、省メモリ化、armhf 移植が控えており、
到達しても X 側のバンドル更新で壊れ続ける。

## 単体で残す価値があるもの

本人の評価では「特になし」。vendor パッチや JS ポリフィルは X のバンドルに合わせた対症療法が多く、
上流へ還元するほどの汎用性は無いと判断している。

## 次にやるなら

**フル Web ブラウザではなく、専用クライアントにする。** X は公開 API が実質使えず、Web 版を動かすしかなかったが、
Mastodon なら API で専用クライアントが作れる。NetWalker で SNS を見るという目的は、
Mastodon の専用クライアントで試す方向に切り替えた。

## 手元で動かす場合

元リポジトリには `target/` が 16GB あった。ビルドには Rust 1.91 以上が必要で、Blitz は git 依存(コミット固定)。

```sh
cargo run --release -- https://example.com/
cargo run --release -- --screenshot out.png https://ja.wikipedia.org/wiki/スナメリ
```

## ライセンス

MIT License または Apache License 2.0 のいずれか(利用者が選択)。
[LICENSE-MIT](LICENSE-MIT) と [LICENSE-APACHE](LICENSE-APACHE) を参照。

`vendor/` と `crates/blitz-vibey-script/` には
[Blitz](https://github.com/DioxusLabs/blitz)(DioxusLabs)と [Boa](https://github.com/boa-dev/boa)
のコードを改変して含んでおり、いずれも MIT OR Apache-2.0 で配布されている。
