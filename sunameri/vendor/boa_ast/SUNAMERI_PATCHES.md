# boa_ast 0.22.0 への sunameri パッチ

crates.io の boa_ast 0.22.0 をコピーし、以下を変更している(`[patch.crates-io]` で差し替え)。

1. `src/scope.rs` `escape_this_in_enclosing_function_scope`: arrow 関数内の `this` の脱出印を、
   最初に越えた関数スコープだけでなく外側の関数スコープ全てに付ける。上流では中間の arrow 関数に
   印が付くだけで、本来の `this` を持つメソッドの環境が最適化で省かれ、2 段以上ネストした arrow 関数の
   `this` が undefined になっていた。X のポスト作成モーダル(React のクラスコンポーネントで
   `children: () => () => this._render()`)が「問題が発生しました」になる原因。
