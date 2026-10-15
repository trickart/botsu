# boa_engine 0.22.0 への sunameri パッチ

crates.io の boa_engine 0.22.0 をコピーし、以下を変更している(`[patch.crates-io]` で差し替え)。

1. `src/vm/mod.rs` `check_runtime_limits`: 再帰上限・VM スタック上限に達したときに、
   JS から捕捉できない `RuntimeLimitError` ではなく、ブラウザと同じく捕捉可能な
   `RangeError: Maximum call stack size exceeded` を投げる。
   X のボット検知(castle)は意図的に無限再帰させて RangeError を捕まえるため必要。
   ループ回数上限(暴走対策)は従来どおり捕捉不可のまま。
2. `src/native_function/mod.rs`: 環境変数 `SUNAMERI_TRACE_NATIVE` が設定されていると、
   ネイティブ関数がエラーを返したときに関数名とエラーを stderr に出す(デバッグ用)。
3. `src/builtins/intl/date_time_format/mod.rs`: `Intl.DateTimeFormat` の既定タイムゾーンを
   "Etc/UTC" 固定から、TZ 環境変数または /etc/localtime のリンク先(システムのタイムゾーン)に変更。
   `resolvedOptions().timeZone` も BCP47 の短縮 id("jptyo")ではなく IANA 名("Asia/Tokyo")を返す。
   Date の getTimezoneOffset とサイトに送るタイムゾーンが食い違っていたため。
4. `src/builtins/date/utils.rs` `parse_legacy_date`: `Date.parse` が ISO と toString/toUTCString 形式
   以外を受け付けなかったので、ブラウザと同様の緩い旧来書式(Twitter API の
   "Wed Oct 15 00:00:00 +0000 2026"、"15 Oct 2026 10:00 GMT"、"10/15/2026" など)を解釈する
   fallback を追加。X のタイムラインは created_at をこの形式で受け取り、失敗すると
   toISOString で RangeError になる。
5. `src/builtins/intl/date_time_format/mod.rs` `formatToParts`: 未実装だった
   `Intl.DateTimeFormat.prototype.formatToParts` を追加。ICU の整形結果をトークンに分け、
   ローカル時刻の成分と突き合わせて種類を決める近似実装(X のスポーツ欄が使う)。
6. `src/builtins/intl/date_time_format/`: `year: "numeric"` で 4 桁の年(YearStyle::Full)、
   "2-digit" 指定があれば桁揃え(Alignment::Column)を ICU に渡す。従来は "10/15/26" のように
   年が 2 桁になり、X のスポーツ欄が Number(year) で 26 年扱いにしていた。
