#!/bin/sh
# Claude Code の statusLine スロットを Orca と共有するためのラッパー。
#
# Orca は statusLine を「表示」ではなく `rate_limits` の取得口として使っている。
# 公式フック（~/.orca/agent-hooks/claude-statusline.{cmd,sh}）は stdin を読んで
# Orca の daemon へ POST するだけで stdout には何も書かない。したがって同じ
# stdin を両者へ配れば、Orca の UI 連携を壊さずに claude-statusline を描画できる。
#
# 環境変数（省略時は下の探索順）:
#   STATUSLINE_CJS      statusline.cjs のパス
#   STATUSLINE_NODE_BIN node の実体

payload=$(cat)

# ---- Orca 側（出力なし・失敗しても描画は止めない）----
orca_hooks="${HOME}/.orca/agent-hooks"
if [ -f "${orca_hooks}/claude-statusline.cmd" ]; then
  printf '%s' "$payload" | "${orca_hooks}/claude-statusline.cmd" >/dev/null 2>&1 || :
elif [ -f "${orca_hooks}/claude-statusline.sh" ]; then
  printf '%s' "$payload" | /bin/sh "${orca_hooks}/claude-statusline.sh" >/dev/null 2>&1 || :
fi

# ---- 描画側 ----
cjs="$STATUSLINE_CJS"
if [ -z "$cjs" ]; then
  for c in "$HOME/.claude/statusline.cjs" "$HOME/src/claude-statusline/statusline.cjs"; do
    if [ -f "$c" ]; then cjs="$c"; break; fi
  done
fi
[ -n "$cjs" ] || exit 0

node_bin="$STATUSLINE_NODE_BIN"
if [ -z "$node_bin" ]; then
  if [ -x /opt/homebrew/bin/node ]; then
    node_bin=/opt/homebrew/bin/node
  else
    node_bin=$(command -v node 2>/dev/null) || node_bin=node
  fi
fi

printf '%s' "$payload" | "$node_bin" "$cjs"
