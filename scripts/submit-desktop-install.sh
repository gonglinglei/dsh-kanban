#!/bin/bash
# Submit scripts/desktop-install.sh as a launchd job so it survives the Desktop
# app quitting (the reserved `desktop` profile can only be managed while the app
# is not running, and this repo's dev loop usually lives inside that app).
#
# Usage: scripts/submit-desktop-install.sh [--now]
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$REPO_DIR/scripts/desktop-install.sh"
LABEL="com.dsh-kanban.desktop-install"
OUT_DIR="${HOME:-/Users/bytedance}/Library/Logs/dsh-kanban-desktop"

[ -x "$RUNNER" ] || { echo "runner not executable: $RUNNER" >&2; exit 1; }
mkdir -p "$OUT_DIR"

launchctl remove "$LABEL" >/dev/null 2>&1

launchctl submit -l "$LABEL" \
  -o "$OUT_DIR/launchd.out" \
  -e "$OUT_DIR/launchd.err" \
  -- /bin/bash "$RUNNER" "$@"

echo "submitted $LABEL"
echo "  runner: $RUNNER $*"
echo "  log:    $OUT_DIR/install.log"
echo "  report: $OUT_DIR/report.md"
