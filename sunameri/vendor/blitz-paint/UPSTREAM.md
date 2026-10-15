# blitz-paint のベンダリング

上流: https://github.com/DioxusLabs/blitz コミット e72650a6e67941852fddf025295cfee30c39ea32 の
packages/blitz-paint。ルートの Cargo.toml の `[patch."https://github.com/DioxusLabs/blitz"]` で差し替えている。

## sunameri での変更

- Cargo.toml: workspace 依存を具体的なバージョンに置き換え。
- `src/render/border.rs` `draw_border`: 幅 0 の辺をスキップ。幅 0 の辺の角の弧を求めると
  0/0 で NaN のパスになり、vello が毎フレーム「A path contains NaN」を出していた。
- `src/kurbo_css/css_box.rs` `start_angle`: 比が NaN/無限大のときに極限の角度を返す。
- `src/render.rs` `compute_oof_reparenting` / `draw_children`: 包含ブロックへ持ち上げられた
  out-of-flow ボックス(fixed/absolute)の手前に stacking context の根があるときは、その根の中で
  木の順に描く。X のモーダルでは fixed のマスクが fixed のコンテナ内にあり、Blitz の順序だと
  同じコンテナ内のダイアログより後に描かれてダイアログが暗くなっていた。
