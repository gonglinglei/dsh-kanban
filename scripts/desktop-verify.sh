#!/bin/bash
# dsh-kanban → DeepSeek Harness Desktop: verify (read-only, safe to run any time)
#
# Checks the reserved `desktop` profile for the installed bundle and probes the
# running Desktop host for the plugin's loopback-public routes. Writes a report
# to $HOME/Library/Logs/dsh-kanban-desktop/verify.md and prints it.
#
# Usage: scripts/desktop-verify.sh
set -u

HOME_DIR="${HOME:-/Users/bytedance}"
PROFILE_DIR="$HOME_DIR/.dsh/profiles/desktop"
MANIFEST="$PROFILE_DIR/package.json"
PLUGIN_DIR="$HOME_DIR/Workspace/dsh-kanban/packages/dsh-kanban"
PKG="@gonglinglei/dsh-kanban"
OUT_DIR="$HOME_DIR/Library/Logs/dsh-kanban-desktop"
REPORT="$OUT_DIR/verify.md"

# The Desktop host's port is chosen at launch (a restart usually picks a new
# one), so never hardcode it: the session's DSH_WEB_URL wins, then the actual
# listening socket, then the historical default.
detect_host_url() {
  if [ -n "${DSH_WEB_URL:-}" ]; then printf '%s' "$DSH_WEB_URL"; return; fi
  local port
  port=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/DeepSeek/ { n = split($9, a, ":"); if (n > 1) { print a[n]; exit } }')
  if [ -n "$port" ]; then printf 'http://127.0.0.1:%s' "$port"; else printf 'http://127.0.0.1:19387'; fi
}
HOST_URL="$(detect_host_url)"

mkdir -p "$OUT_DIR"

probe() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$HOST_URL$1" 2>/dev/null || echo "conn-error"; }

app_running="no"
ps -Ao command= 2>/dev/null | grep -q "[C]ontents/MacOS/DeepSeek Harness" && app_running="yes"
host_code=$(probe /)
health=$(probe /kanban/health)
state=$(probe /kanban/state)
index=$(probe /index.html)
bundle=$(probe "/plugins/$PKG/client.js")

dep="no"; sed -n '/"dependencies"/,/}/p' "$MANIFEST" 2>/dev/null | grep -q "$PKG" && dep="yes"
bundles="no"; sed -n '/"bundles"/,/\]/p' "$MANIFEST" 2>/dev/null | grep -q "$PKG" && bundles="yes"
artifacts="no"
[ -f "$PROFILE_DIR/node_modules/$PKG/lib/index.js" ] && [ -f "$PROFILE_DIR/node_modules/$PKG/lib/client.js" ] && artifacts="yes"
link_kind=$(readlink "$PROFILE_DIR/node_modules/$PKG" 2>/dev/null || echo "(not a symlink / missing)")
ledger="no"; [ -f "$HOME_DIR/.dsh/kanban/projects.json" ] && ledger="yes"

host_half="FAIL"
[ "$health" = "200" ] && host_half="PASS"

# Client half: the Desktop renderer compiles every client bundle it loads and
# keys the V8 code cache by the script URL, which for the shell is
# dsh-app://app/plugins/<pkg>/client.js?rev=<bundle hash>. V8's cache key stores
# that as ".../plugins/??<pkg>/client.js&rev=<hash>", so match on the package
# path rather than on "plugins/<pkg>". A hit proves the Shell fetched and
# executed this plugin's browser half.
renderer_dir="$HOME_DIR/Library/Application Support/@deepseek-ai/dsh-desktop/Code Cache"
cache_hits=$(grep -ral "$PKG/client.js" "$renderer_dir" 2>/dev/null)
cache_files=$(printf '%s\n' "$cache_hits" | grep -c .)
# HMR leaves one cache entry per loaded revision; report the newest one.
newest=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest="$f"; fi
done <<< "$cache_hits"
rev=""
[ -n "$newest" ] && rev=$(grep -a -o "$PKG/client.js.\{0,4\}rev=[a-z0-9]\{6,\}" "$newest" 2>/dev/null | head -1 | grep -o "rev=[a-z0-9]*")
client_half="FAIL"
[ "$cache_files" != "0" ] && client_half="PASS"

if [ "$dep" = "yes" ] && [ "$bundles" = "yes" ] && [ "$artifacts" = "yes" ] && [ "$host_half" = "PASS" ] && [ "$client_half" = "PASS" ]; then
  verdict="PASS"
elif [ "$dep" = "yes" ] && [ "$bundles" = "yes" ] && [ "$artifacts" = "yes" ] && [ "$host_half" = "PASS" ]; then
  verdict="HOST-LIVE-CLIENT-PENDING"
elif [ "$dep" = "yes" ] && [ "$bundles" = "yes" ] && [ "$artifacts" = "yes" ]; then
  verdict="INSTALLED-BUT-NOT-LIVE"
else
  verdict="FAIL"
fi

{
  echo "# dsh-kanban → Desktop: 校验"
  echo
  echo "- 时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "- 结论: **$verdict**"
  echo
  echo "| 检查项 | 结果 |"
  echo "| --- | --- |"
  echo "| DeepSeek Harness 进程在跑 | $app_running |"
  echo "| profile manifest 含依赖 | $dep |"
  echo "| \`dsh.profile.bundles\` 启用 | $bundles |"
  echo "| \`node_modules/$PKG\` → $link_kind | $artifacts |"
  echo "| 账本 \`~/.dsh/kanban/projects.json\` | $ledger |"
  echo "| **host 半身** \`GET /kanban/health\` = 200 | $host_half ($health) |"
  echo "| \`GET /kanban/state\` | $state |"
  echo "| **client 半身** 渲染进程已编译本插件 bundle（${rev}） | $client_half (code cache 命中 ${cache_files}) |"
  echo "| \`GET /\`（Host 根，需 cookie） | $host_code |"
  echo "| \`GET /index.html\`（需 cookie） | $index |"
  echo "| \`GET /plugins/$PKG/client.js\`（未带 cookie） | $bundle |"
  echo
  echo "> 最后一个探针仅供参考：\`/plugins/*\` 与 \`/index.html\` 走 Host 的 auth cookie，"
  echo "> 只有 Desktop Shell 持有；client 半身以渲染进程 code cache 为准（URL 形如"
  echo "> \`dsh-app://app/plugins/$PKG/client.js?rev=…\`）。"
} >"$REPORT"

cat "$REPORT"
echo
echo "report: $REPORT"
[ "$verdict" = "FAIL" ] && exit 1
exit 0
