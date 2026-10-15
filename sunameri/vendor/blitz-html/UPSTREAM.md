# blitz-html のベンダリング

上流: https://github.com/DioxusLabs/blitz コミット e72650a6e67941852fddf025295cfee30c39ea32 の
packages/blitz-html。ルートの Cargo.toml の `[patch."https://github.com/DioxusLabs/blitz"]` で差し替えている。

## sunameri での変更

- Cargo.toml: workspace 依存を具体的なバージョンに置き換え。
- `src/html_sink.rs`: `set_scripting_enabled(bool)` を追加。true のとき html5ever の
  `scripting_enabled` を有効にし、`<noscript>` の中身を要素ではなく生テキストとして扱う
  (ブラウザと同じ)。X は noscript 内の `<style>` で `#react-root { display: none }` にしており、
  要素として解釈するとアプリが描画されても画面が真っ白になる。
