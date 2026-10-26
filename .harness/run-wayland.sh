#!/usr/bin/env bash
set -euo pipefail

# Runs Linux Wayland Native Validation Harness with headless Weston compositor under dbus-run-session.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(pwd)"
OUT_DIR="${REPO_DIR}/artifacts/linux-wayland"

rm -f -- "${OUT_DIR}/validation-report.json"
mkdir -p "${OUT_DIR}"

exec dbus-run-session bash -c '
  set -euo pipefail

  export XDG_RUNTIME_DIR="$(mktemp -d /tmp/pi-qc-wayland-runtime.XXXXXX)"
  chmod 700 "$XDG_RUNTIME_DIR"

  # Start headless Weston compositor
  weston --backend=headless --socket=wayland-1 &
  WESTON_PID=$!

  cleanup() {
    kill $WESTON_PID 2>/dev/null || true
    if [ -n "${PORTAL_PID:-}" ]; then kill $PORTAL_PID 2>/dev/null || true; fi
    rm -rf "$XDG_RUNTIME_DIR" 2>/dev/null || true
  }
  trap cleanup EXIT

  # Wait for Wayland socket readiness
  echo "[LINUX-WAYLAND] Awaiting Wayland socket readiness..."
  READY=0
  for i in $(seq 1 50); do
    if [ -e "$XDG_RUNTIME_DIR/wayland-1" ]; then
      READY=1
      break
    fi
    sleep 0.1
  done

  if [ "$READY" -ne 1 ]; then
    echo "[LINUX-WAYLAND] Error: Weston socket failed to initialize." >&2
    exit 1
  fi
  echo "[LINUX-WAYLAND] Wayland socket ready at $XDG_RUNTIME_DIR/wayland-1."

  # Attempt starting xdg-desktop-portal if present
  for portal_bin in /usr/libexec/xdg-desktop-portal /usr/lib/xdg-desktop-portal; do
    if [ -x "$portal_bin" ]; then
      "$portal_bin" &
      PORTAL_PID=$!
      sleep 1
      break
    fi
  done

  export WAYLAND_DISPLAY="wayland-1"
  echo "[LINUX-WAYLAND] Starting Electron on native Wayland (production defaults)..."
  LAUNCHER_EXIT=0
  npx --no-install electron --no-sandbox \
    --ozone-platform=wayland \
    "'"${SCRIPT_DIR}"'/launcher.cjs" \
    --repo-dir="'"${REPO_DIR}"'" \
    --out-dir="'"${OUT_DIR}"'" || LAUNCHER_EXIT=$?

  echo "[LINUX-WAYLAND] Validating report acceptance..."
  VALIDATOR_EXIT=0
  node "'"${SCRIPT_DIR}"'/validate-report.cjs" \
    --report="'"${OUT_DIR}"'/validation-report.json" \
    --expected-platform=linux \
    --expected-display-server=wayland || VALIDATOR_EXIT=$?

  if [ "$LAUNCHER_EXIT" -ne 0 ]; then
    echo "[LINUX-WAYLAND] Error: Launcher exited with non-zero exit code: $LAUNCHER_EXIT" >&2
    exit "$LAUNCHER_EXIT"
  fi

  if [ "$VALIDATOR_EXIT" -ne 0 ]; then
    echo "[LINUX-WAYLAND] Error: Report validation failed with exit code: $VALIDATOR_EXIT" >&2
    exit "$VALIDATOR_EXIT"
  fi
'
