#!/usr/bin/env bash
set -euo pipefail

# Runs Linux X11 Native Validation Harness with a real window manager (openbox) under Xvfb.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(pwd)"
OUT_DIR="${REPO_DIR}/artifacts/linux-x11"

rm -f -- "${OUT_DIR}/validation-report.json"
mkdir -p "${OUT_DIR}"

# Start Xvfb and Openbox WM
exec xvfb-run --auto-servernum --server-args="-screen 0 1440x900x24" bash -c '
  set -euo pipefail

  OPENBOX_ROOT="$(mktemp -d /tmp/pi-qc-openbox.XXXXXX)"
  OPENBOX_PID=""
  cleanup() {
    if [ -n "$OPENBOX_PID" ]; then kill "$OPENBOX_PID" 2>/dev/null || true; fi
    rm -rf -- "$OPENBOX_ROOT"
  }
  trap cleanup EXIT

  # Keep Openbox and its per-run config entirely outside the real user profile.
  mkdir -p "$OPENBOX_ROOT/home" "$OPENBOX_ROOT/config"
  cat << 'EOF' > "$OPENBOX_ROOT/config/rc.xml"
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus>
    <focusNew>yes</focusNew>
    <followMouse>no</followMouse>
    <focusLast>yes</focusLast>
    <underMouse>no</underMouse>
  </focus>
</openbox_config>
EOF

  # Start Openbox window manager for standard EWMH focus and active window handling
  HOME="$OPENBOX_ROOT/home" XDG_CONFIG_HOME="$OPENBOX_ROOT/config" \
    openbox --config-file "$OPENBOX_ROOT/config/rc.xml" &
  OPENBOX_PID=$!

  # Wait for window manager to be active
  for i in $(seq 1 30); do
    if xdotool get_desktop >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  echo "[LINUX-X11] Window manager active. Starting Electron validation..."
  if [ -n "${PI_QC_STARTUP_PHASE:-}" ]; then
    npx --no-install electron --no-sandbox "'"${SCRIPT_DIR}"'/startup-overlap.cjs" \
      --repo-dir="'"${REPO_DIR}"'" \
      --phase="$PI_QC_STARTUP_PHASE" \
      --out-dir="'"${OUT_DIR}"'/startup-$PI_QC_STARTUP_PHASE"
    exit $?
  fi

  LAUNCHER_EXIT=0
  npx --no-install electron --no-sandbox "'"${SCRIPT_DIR}"'/launcher.cjs" \
    --repo-dir="'"${REPO_DIR}"'" \
    --out-dir="'"${OUT_DIR}"'" || LAUNCHER_EXIT=$?

  echo "[LINUX-X11] Validating report acceptance..."
  VALIDATOR_EXIT=0
  node "'"${SCRIPT_DIR}"'/validate-report.cjs" \
    --report="'"${OUT_DIR}"'/validation-report.json" \
    --expected-platform=linux \
    --expected-display-server=x11 || VALIDATOR_EXIT=$?

  if [ "$LAUNCHER_EXIT" -ne 0 ]; then
    echo "[LINUX-X11] Error: Launcher exited with non-zero exit code: $LAUNCHER_EXIT" >&2
    exit "$LAUNCHER_EXIT"
  fi

  if [ "$VALIDATOR_EXIT" -ne 0 ]; then
    echo "[LINUX-X11] Error: Report validation failed with exit code: $VALIDATOR_EXIT" >&2
    exit "$VALIDATOR_EXIT"
  fi
'
