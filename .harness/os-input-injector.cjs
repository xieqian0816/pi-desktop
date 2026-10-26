/**
 * OS-level native keyboard injection for Electron global shortcuts and modal dismissal.
 *
 * Implements genuine OS keyboard injection per platform:
 * - macOS: AppleScript / System Events key code 12 (Q) with {command down, option down}; key code 53 for Escape
 * - Windows: PowerShell P/Invoke user32.dll keybd_event (Ctrl + Alt + Q; Escape 0x1B)
 * - Linux X11: xdotool key --clearmodifiers ctrl+alt+q; xdotool key Escape
 * - Linux Wayland: wtype when available, or explicit D-Bus Introspect detection
 */

'use strict';

const { spawnSync } = require('child_process');

/** Observe the actual native Windows modal, not the dialog Promise creation. */
function inspectNativeWindowsModal(pid, expectedTitle) {
  if (process.platform !== 'win32') return { found: false, reason: 'Windows-only native modal inspection' };
  const psScript = `
$signature = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeModal {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -TypeDefinition $signature -Language CSharp
$targetPid = [uint32]${pid}
$expectedTitle = '${expectedTitle.replace(/'/g, "''")}'
$modal = [IntPtr]::Zero
$callback = [NativeModal+EnumWindowsProc]{
  param([IntPtr]$handle, [IntPtr]$unused)
  $owner = [uint32]0
  [void][NativeModal]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($owner -ne $targetPid -or -not [NativeModal]::IsWindowVisible($handle)) { return $true }
  $title = New-Object System.Text.StringBuilder 512
  $className = New-Object System.Text.StringBuilder 256
  [void][NativeModal]::GetWindowText($handle, $title, $title.Capacity)
  [void][NativeModal]::GetClassName($handle, $className, $className.Capacity)
  if ($title.ToString() -eq $expectedTitle -and $className.ToString() -eq '#32770') {
    $script:modal = $handle
    return $false
  }
  return $true
}
[void][NativeModal]::EnumWindows($callback, [IntPtr]::Zero)
if ($modal -eq [IntPtr]::Zero) { exit 4 }
$activated = [NativeModal]::SetForegroundWindow($modal)
if ([NativeModal]::GetForegroundWindow() -ne $modal) {
  Write-Error "Native modal did not become foreground (SetForegroundWindow returned $activated)"
  exit 5
}
`;
  const result = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
  return { ...result, method: 'windows-native-modal' };
}

function runCommand(cmd, args, options = {}) {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: options.timeout || 5000,
      env: options.env || process.env,
      ...options,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      return {
        success: false,
        status: res.status,
        error: (res.stderr || res.stdout || `Exit status ${res.status}`).trim(),
      };
    }
    return { success: true, status: 0, output: (res.stdout || '').trim() };
  } catch (err) {
    return { success: false, status: -1, error: err.message };
  }
}

/**
 * Injects a global hotkey at the native OS level.
 * @param {string} accelerator - e.g. "CommandOrControl+Alt+Q"
 * @returns {Promise<{ success: boolean, method: string, error?: string }>}
 */
async function injectNativeHotkey(accelerator) {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: Command+Alt+Q (Cmd+Option+Q). Key code 12 is 'q'.
    const script = `
      tell application "System Events"
        key code 12 using {command down, option down}
      end tell
    `;
    const res = runCommand('osascript', ['-e', script]);
    if (!res.success) {
      return {
        success: false,
        method: 'osascript-system-events',
        error: `AppleScript System Events injection failed: ${res.error}`,
      };
    }
    return { success: true, method: 'osascript-system-events' };
  }

  if (platform === 'win32') {
    // Windows: Control+Alt+Q. VK_CONTROL = 0x11, VK_MENU (Alt) = 0x12, VK_Q = 0x51
    const psScript = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class NativeInput {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public static void SendCtrlAltQ() {
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x51, 0, 0, UIntPtr.Zero);
        Thread.Sleep(50);
        keybd_event(0x51, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(0x12, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(0x11, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[NativeInput]::SendCtrlAltQ()
`;
    const res = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
    if (!res.success) {
      return {
        success: false,
        method: 'powershell-sendinput',
        error: `PowerShell SendInput keybd_event failed: ${res.error}`,
      };
    }
    return { success: true, method: 'powershell-sendinput' };
  }

  if (platform === 'linux') {
    const isWayland = Boolean(process.env.WAYLAND_DISPLAY && !process.env.DISPLAY_FORCED_X11);

    if (isWayland) {
      const hasWtype = runCommand('which', ['wtype']).success;
      if (hasWtype) {
        const res = runCommand('wtype', ['-M', 'ctrl', '-M', 'alt', '-k', 'q', '-m', 'alt', '-m', 'ctrl']);
        if (res.success) return { success: true, method: 'wtype' };
        return { success: false, method: 'wtype', error: res.error };
      }
      return {
        success: false,
        method: 'wayland-native',
        error: 'wtype not installed under Wayland',
      };
    }

    // Linux X11
    const hasXdotool = runCommand('which', ['xdotool']).success;
    if (!hasXdotool) {
      return {
        success: false,
        method: 'xdotool',
        error: 'xdotool not installed on Linux X11 runner',
      };
    }

    const res = runCommand('xdotool', ['key', '--clearmodifiers', 'ctrl+alt+q']);
    if (!res.success) {
      return {
        success: false,
        method: 'xdotool',
        error: `xdotool failed: ${res.error}`,
      };
    }
    return { success: true, method: 'xdotool' };
  }

  return { success: false, method: 'unknown', error: `Unsupported platform: ${platform}` };
}

/**
 * Injects a native OS Escape key event to cancel/dismiss native modals.
 * @returns {Promise<{ success: boolean, method: string, error?: string }>}
 */
async function injectNativeEscape() {
  const platform = process.platform;

  if (platform === 'darwin') {
    // Key code 53 is Escape on macOS
    const script = `
      tell application "System Events"
        key code 53
      end tell
    `;
    const res = runCommand('osascript', ['-e', script]);
    if (!res.success) {
      return { success: false, method: 'osascript-escape', error: res.error };
    }
    return { success: true, method: 'osascript-escape' };
  }

  if (platform === 'win32') {
    // VK_ESCAPE = 0x1B
    const psScript = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class NativeEscape {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public static void SendEscape() {
        keybd_event(0x1B, 0, 0, UIntPtr.Zero);
        Thread.Sleep(50);
        keybd_event(0x1B, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[NativeEscape]::SendEscape()
`;
    const res = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
    if (!res.success) {
      return { success: false, method: 'powershell-escape', error: res.error };
    }
    return { success: true, method: 'powershell-escape' };
  }

  if (platform === 'linux') {
    const isWayland = Boolean(process.env.WAYLAND_DISPLAY && !process.env.DISPLAY_FORCED_X11);
    if (isWayland) {
      // If a host X11 display is available for nested Wayland (e.g. Weston X11 backend under Xvfb),
      // xdotool can inject Escape into the compositor window which forwards it to the active Wayland modal.
      const hostDisplay = process.env.PI_QC_HOST_DISPLAY || process.env.DISPLAY;
      if (hostDisplay && runCommand('which', ['xdotool']).success) {
        const res = runCommand('xdotool', ['key', 'Escape'], {
          env: { ...process.env, DISPLAY: hostDisplay },
        });
        if (res.success) {
          return { success: true, method: 'nested-wayland-xdotool-escape' };
        }
      }

      return {
        success: false,
        method: 'wayland-escape',
        error: 'Wayland headless environment cannot drive native modal dialogs via virtual input',
      };
    }

    const res = runCommand('xdotool', ['key', 'Escape']);
    if (!res.success) {
      return { success: false, method: 'xdotool-escape', error: res.error };
    }
    return { success: true, method: 'xdotool-escape' };
  }

  return { success: false, method: 'unknown', error: `Unsupported platform: ${platform}` };
}

/**
 * Queries the Wayland D-Bus session bus via Introspect for org.freedesktop.portal.GlobalShortcuts.
 */
function inspectWaylandPortalCapability() {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) {
    return { isWayland: false, hasGlobalShortcutsInterface: false, reason: 'Not running under Wayland' };
  }

  const introspectRes = runCommand('dbus-send', [
    '--session',
    '--dest=org.freedesktop.portal.Desktop',
    '--type=method_call',
    '--print-reply',
    '/org/freedesktop/portal/desktop',
    'org.freedesktop.DBus.Introspectable.Introspect',
  ]);

  if (!introspectRes.success) {
    return {
      isWayland: true,
      hasGlobalShortcutsInterface: false,
      reason: `D-Bus introspection failed: ${introspectRes.error}`,
    };
  }

  const xml = introspectRes.output;
  const hasGlobalShortcuts = xml.includes('org.freedesktop.portal.GlobalShortcuts');

  return {
    isWayland: true,
    hasGlobalShortcutsInterface: hasGlobalShortcuts,
    reason: hasGlobalShortcuts
      ? 'org.freedesktop.portal.GlobalShortcuts interface exposed by desktop portal'
      : 'org.freedesktop.portal.GlobalShortcuts interface NOT found in /org/freedesktop/portal/desktop introspection XML',
  };
}

module.exports = {
  injectNativeHotkey,
  injectNativeEscape,
  inspectWaylandPortalCapability,
  inspectNativeWindowsModal,
  runCommand,
};
