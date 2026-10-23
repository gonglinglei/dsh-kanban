#!/bin/bash
# dsh-kanban → DeepSeek Harness Desktop
#
# Install the plugin into the Desktop app's *reserved* `desktop` profile and
# verify the result. The reserved profile may only be managed while the app is
# not running, and this script is expected to outlive the app process that
# launched it, so it is submitted through launchctl (see submit-desktop-install.sh)
# rather than run as a child of the app.
#
# Usage:
#   scripts/desktop-install.sh            # wait for the app to exit, then install
#   scripts/desktop-install.sh --now      # fail fast if the app is still running
#   scripts/desktop-install.sh --no-open  # do not relaunch the app afterwards
#
# Output: $HOME/Library/Logs/dsh-kanban-desktop/{install.log,report.md}

set -u

MODE_NOW=0
MODE_OPEN=1
for arg in "$@"; do
  case "$arg" in
    --now) MODE_NOW=1 ;;
    --no-open) MODE_OPEN=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

HOME_DIR="${HOME:-/Users/bytedance}"
APP="/Applications/DeepSeek Harness.app"
CLI="$APP/Contents/Resources/runtime/cli/bin/dsh"
PROFILE_DIR="$HOME_DIR/.dsh/profiles/desktop"
MANIFEST="$PROFILE_DIR/package.json"
PLUGIN_DIR="$HOME_DIR/Workspace/dsh-kanban/packages/dsh-kanban"
PKG="@gonglinglei/dsh-kanban"
OUT_DIR="$HOME_DIR/Library/Logs/dsh-kanban-desktop"
LOG="$OUT_DIR/install.log"
REPORT="$OUT_DIR/report.md"
HOST_URL="http://127.0.0.1:19387"

# How long to wait for the user to quit the app before giving up (seconds).
WAIT_APP_EXIT_S=${DSH_INSTALL_WAIT_APP_EXIT_S:-1800}
# How long the plugin command itself may run before the watchdog kills it.
INSTALL_TIMEOUT_S=${DSH_INSTALL_TIMEOUT_S:-900}
# How long to wait for the relaunched app's host port to answer.
WAIT_BOOT_S=${DSH_INSTALL_WAIT_BOOT_S:-240}

mkdir -p "$OUT_DIR"
exec >>"$LOG" 2>&1

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
hr() { printf '%s\n' "------------------------------------------------------------"; }

INSTALL_EXIT="skipped"
INSTALL_NOTE=""
MANIFEST_OK="no"
BUNDLE_ENABLED="no"
SYMLINK_OK="no"
HOST_UP="no"
HOST_HALF_OK="no"
HEALTH_CODE="n/a"
STATE_CODE="n/a"
PLUGIN_BUNDLE_CODE="n/a"
APP_RELAUNCHED="no"

say "runner start (pid $$, mode_now=$MODE_NOW, open_after=$MODE_OPEN)"
hr

# --- 0. pre-state -----------------------------------------------------------
say "pre: probing running host at $HOST_URL"
probe() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$HOST_URL$1" 2>/dev/null || echo "conn-error"; }
say "pre: /index.html=$(probe /index.html) /kanban/health=$(probe /kanban/health)"
if [ -f "$MANIFEST" ]; then
  say "pre: desktop manifest bundles: $(sed -n '/"bundles"/,/]/p' "$MANIFEST" | tr -d ' \n')"
else
  say "pre: FATAL no desktop profile manifest at $MANIFEST (open the app once first)"
  INSTALL_NOTE="Desktop profile manifest missing; open DeepSeek Harness once, quit it, then re-run."
fi

# --- 1. wait for the app to exit -------------------------------------------
# macOS pgrep -f proved unreliable for this argv (it misses the backend
# process), so match the process table directly. The bracketed pattern keeps
# grep's own argv out of the match.
app_running() {
  ps -Ao command= 2>/dev/null | grep -q "[C]ontents/MacOS/DeepSeek Harness"
}
if [ -f "$MANIFEST" ]; then
  if app_running; then
    if [ "$MODE_NOW" = "1" ]; then
      say "app still running and --now was given; aborting"
      INSTALL_EXIT="aborted"
      INSTALL_NOTE="DeepSeek Harness was still running."
    else
      say "waiting up to ${WAIT_APP_EXIT_S}s for DeepSeek Harness to quit (Cmd+Q)…"
      waited=0
      while app_running; do
        if [ "$waited" -ge "$WAIT_APP_EXIT_S" ]; then
          say "timed out waiting for the app to quit"
          INSTALL_EXIT="aborted"
          INSTALL_NOTE="Timed out waiting for DeepSeek Harness to quit."
          break
        fi
        sleep 2
        waited=$((waited + 2))
      done
      [ "$INSTALL_EXIT" = "aborted" ] || say "app exited after ~${waited}s"
    fi
  else
    say "app already not running"
  fi
fi

# --- 2. install into the reserved desktop profile ---------------------------
if [ "$INSTALL_EXIT" = "skipped" ]; then
  if [ ! -x "$CLI" ]; then
    say "FATAL bundled dsh CLI not found at $CLI"
    INSTALL_EXIT="failed"
    INSTALL_NOTE="Bundled Desktop CLI missing."
  else
    # Back up the manifest: the reserved profile belongs to the app.
    cp "$MANIFEST" "$MANIFEST.bak-$(date '+%Y%m%d-%H%M%S')" && say "backed up $MANIFEST"
    say "running: dsh plugin --profile desktop add link:$PLUGIN_DIR  (timeout ${INSTALL_TIMEOUT_S}s)"
    "$CLI" plugin --profile desktop add "link:$PLUGIN_DIR" >"$OUT_DIR/plugin-add.out" 2>&1 &
    install_pid=$!
    watchdog=0
    while kill -0 "$install_pid" 2>/dev/null; do
      if [ "$watchdog" -ge "$INSTALL_TIMEOUT_S" ]; then
        say "watchdog: killing plugin command after ${INSTALL_TIMEOUT_S}s"
        kill "$install_pid" 2>/dev/null
        INSTALL_NOTE="Plugin command exceeded ${INSTALL_TIMEOUT_S}s and was killed."
        break
      fi
      sleep 2
      watchdog=$((watchdog + 2))
    done
    wait "$install_pid"
    INSTALL_EXIT=$?
    say "plugin command exit=$INSTALL_EXIT"
    say "--- plugin command output ---"
    sed 's/^/  /' "$OUT_DIR/plugin-add.out"
    say "--- end plugin command output ---"
  fi
fi

# --- 3. post-install assertions --------------------------------------------
if [ -f "$MANIFEST" ]; then
  if grep -q "\"$PKG\"" "$MANIFEST"; then
    MANIFEST_OK="yes"
  fi
  # bundles: [ "@deepseek-ai/dsh-base", … , "@gonglinglei/dsh-kanban" ]
  if sed -n '/"bundles"/,/]/p' "$MANIFEST" | grep -q "$PKG"; then
    BUNDLE_ENABLED="yes"
  fi
fi
if [ -f "$PROFILE_DIR/node_modules/$PKG/lib/index.js" ] && [ -f "$PROFILE_DIR/node_modules/$PKG/lib/client.js" ]; then
  SYMLINK_OK="yes"
fi
say "post: manifest_has_dependency=$MANIFEST_OK bundle_enabled=$BUNDLE_ENABLED built_artifacts_reachable=$SYMLINK_OK"
if [ -f "$MANIFEST" ]; then
  say "post: desktop manifest bundles: $(sed -n '/"bundles"/,/]/p' "$MANIFEST" | tr -d ' \n')"
fi

# --- 4. relaunch ------------------------------------------------------------
if [ "$MODE_OPEN" = "1" ] && [ "$INSTALL_EXIT" != "aborted" ]; then
  say "relaunching DeepSeek Harness"
  if open -a "DeepSeek Harness"; then
    APP_RELAUNCHED="yes"
    waited=0
    while [ "$waited" -lt "$WAIT_BOOT_S" ]; do
      code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$HOST_URL/index.html" 2>/dev/null || echo "conn-error")
      if [ "$code" != "conn-error" ] && [ "$code" != "000" ]; then
        HOST_UP="yes"
        break
      fi
      sleep 3
      waited=$((waited + 3))
    done
    say "host reachable after ${waited}s: $HOST_UP"
  else
    say "WARN: open -a failed; start DeepSeek Harness manually"
  fi
fi

# --- 5. route probes --------------------------------------------------------
# dsh-kanban's own routes are loopback-public (the host checks the peer itself),
# so GET /kanban/health answering 200 IS the host-half liveness signal. The
# /index.html and /plugins/... probes stay informational: those paths are behind
# the Host's auth cookie, which only the Desktop shell holds, so an
# unauthenticated 401/404 says nothing about whether the plugin is loaded.
if [ "$HOST_UP" = "yes" ]; then
  HEALTH_CODE=$(probe /kanban/health)
  STATE_CODE=$(probe /kanban/state)
  PLUGIN_BUNDLE_CODE=$(probe "/plugins/$PKG/client.js")
  INDEX_CODE=$(probe /index.html)
  [ "$HEALTH_CODE" = "200" ] && HOST_HALF_OK="yes"
  say "probe: /kanban/health=$HEALTH_CODE /kanban/state=$STATE_CODE /index.html=$INDEX_CODE (auth-gated) /plugins/$PKG/client.js=$PLUGIN_BUNDLE_CODE (auth-gated)"
fi

# --- 6. report --------------------------------------------------------------
if [ "$INSTALL_EXIT" = "0" ] && [ "$MANIFEST_OK" = "yes" ] && [ "$BUNDLE_ENABLED" = "yes" ] && [ "$SYMLINK_OK" = "yes" ]; then
  if [ "$HOST_HALF_OK" = "yes" ]; then
    VERDICT="INSTALLED+HOST-LIVE"
  else
    VERDICT="INSTALLED(RESTART-NEEDED)"
  fi
else
  VERDICT="NOT-INSTALLED"
fi

{
  echo "# dsh-kanban → DeepSeek Harness Desktop: install report"
  echo
  echo "- 时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "- 结论: **$VERDICT**"
  echo "- profile: \`$PROFILE_DIR\`"
  echo "- 插件目录: \`$PLUGIN_DIR\`"
  echo
  echo "## 步骤"
  echo
  echo "| 项 | 值 |"
  echo "| --- | --- |"
  echo "| plugin 命令退出码 | $INSTALL_EXIT |"
  echo "| manifest 含依赖 \`$PKG\` | $MANIFEST_OK |"
  echo "| \`dsh.profile.bundles\` 已启用 | $BUNDLE_ENABLED |"
  echo "| \`node_modules/$PKG/{lib/index.js,lib/client.js}\` 可达 | $SYMLINK_OK |"
  echo "| App 已重新拉起 | $APP_RELAUNCHED |"
  echo "| Host 端口 $HOST_URL 可答 | $HOST_UP |"
  echo "| \`/kanban/health\` = 200（host 半身在线） | $HEALTH_CODE |"
  echo "| \`/kanban/state\` | $STATE_CODE |"
  echo "| \`/index.html\`（未带 cookie，仅参考） | $INDEX_CODE |"
  echo "| \`/plugins/$PKG/client.js\`（未带 cookie，仅参考） | $PLUGIN_BUNDLE_CODE |"
  echo
  [ -n "$INSTALL_NOTE" ] && { echo "备注: $INSTALL_NOTE"; echo; }
  echo "pnpm/CLI 原始输出: \`$OUT_DIR/plugin-add.out\`；完整日志: \`$LOG\`。"
  echo
  echo "## 验收口径"
  echo
  echo "- host 半身：\`GET /kanban/health\` 返回 200（该路由只认 loopback，不走 Host 的 auth cookie）。"
  echo "  桌面版是驻留进程，\`reconcile\` 后 Loader 会热组合，**无需重启**即可挂载；200 即代表已加载。"
  echo "- client 半身：需要在 Desktop 窗口里重载一次页面（Cmd+R），侧边栏出现「看板」入口。"
  echo "- 冷启动：\`--profile desktop --dump-config\` 被 App 独占（*profile \"desktop\" is managed exclusively by the Electron application*），"
  echo "  因此只能通过完整退出并重开 App 来验证冷启动；manifest 已在安装前备份为 \`package.json.bak-*\`。"
} >"$REPORT"

say "verdict=$VERDICT report=$REPORT"
say "runner done"
