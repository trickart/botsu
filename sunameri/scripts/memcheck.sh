#!/usr/bin/env bash
# 指定 URL を sunameri で開き、常駐メモリ(RSS)を 1 秒ごとに記録する。
# 使い方: scripts/memcheck.sh https://example.com [秒数]
set -euo pipefail
URL="${1:-https://example.com/}"
SECS="${2:-20}"
BIN="${SUNAMERI_BIN:-target/release/sunameri}"
"$BIN" "$URL" & PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
echo "sec rss_mb"
for i in $(seq 1 "$SECS"); do
  sleep 1
  if ! kill -0 "$PID" 2>/dev/null; then echo "process exited"; break; fi
  if [[ "$(uname)" == "Darwin" ]]; then
    RSS_KB=$(ps -o rss= -p "$PID" | tr -d ' ')
  else
    RSS_KB=$(awk '/VmRSS/ {print $2}' /proc/$PID/status)
  fi
  echo "$i $((RSS_KB / 1024))"
done
