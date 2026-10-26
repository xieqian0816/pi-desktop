/**
 * Native CJS Launcher for Pi Desktop Quick Chat Platform Validation.
 *
 * Runs built real main/preload/renderer in a clean, private userData root,
 * observes global shortcut registration without faking input, and runs native
 * platform validation scenarios on Windows, Linux X11, and Linux Wayland.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── 1. Parse Arguments ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(prefix, defaultVal) {
  const match = args.find((a) => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : defaultVal;
}

const repoDir = path.resolve(getArg('--repo-dir=', process.cwd()));
const artifactsDir = path.resolve(getArg('--out-dir=', '/tmp/pi-qc-platform-validation-harness/artifacts'));
const reportPath = path.join(artifactsDir, 'validation-report.json');
const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

// A prior report must never survive a failed startup or be mistaken for this run.
fs.rmSync(reportPath, { force: true });
fs.mkdirSync(artifactsDir, { recursive: true });

const electron = require('electron');
const { app, BrowserWindow, globalShortcut, Menu, dialog } = electron;

// Observe real native dialog outcomes without changing the returned promise.
const nativeDialogs = [];
const originalShowMessageBox = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = function (...args) {
  const observation = { settled: false, response: null };
  nativeDialogs.push(observation);
  const result = originalShowMessageBox(...args);
  void result.then(({ response }) => {
    observation.settled = true;
    observation.response = response;
    console.log(`[HARNESS] Native dialog settled with response ${response}`);
  }).catch((error) => {
    observation.settled = true;
    observation.error = error.message;
    console.error(`[HARNESS] Native dialog rejected: ${error.message}`);
  });
  return result;
};

process.on('uncaughtException', (err) => {
  console.error('[HARNESS] Uncaught exception in main process:', err);
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[HARNESS] Unhandled rejection in main process:', reason);
  app.exit(1);
});

// ─── 2. Complete Sandbox Isolation ───────────────────────────────────────────

const sandboxRoot = path.join(os.tmpdir(), `pi-qc-sandbox-${uniqueSuffix}`);
const homeDir = path.join(sandboxRoot, 'home');
const userDataDir = path.join(sandboxRoot, 'userdata');
const sessionDir = path.join(userDataDir, 'session');
const piAgentDir = path.join(homeDir, '.pi', 'agent');
const ompAgentDir = path.join(homeDir, '.omp', 'agent');
const xdgConfigDir = path.join(homeDir, '.config');
const xdgCacheDir = path.join(homeDir, '.cache');
const xdgDataDir = path.join(homeDir, '.local', 'share');
const xdgStateDir = path.join(homeDir, '.local', 'state');

const privateDirs = [
  homeDir,
  userDataDir,
  sessionDir,
  piAgentDir,
  ompAgentDir,
  xdgConfigDir,
  xdgCacheDir,
  xdgDataDir,
  xdgStateDir,
];
if (process.platform === 'win32') {
  privateDirs.push(
    path.join(homeDir, 'AppData', 'Roaming'),
    path.join(homeDir, 'AppData', 'Local'),
    path.join(homeDir, 'AppData', 'LocalLow')
  );
}
for (const dir of privateDirs) fs.mkdirSync(dir, { recursive: true });

process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.XDG_CONFIG_HOME = xdgConfigDir;
process.env.XDG_CACHE_HOME = xdgCacheDir;
process.env.XDG_DATA_HOME = xdgDataDir;
process.env.XDG_STATE_HOME = xdgStateDir;
if (process.platform === 'win32') {
  process.env.APPDATA = path.join(homeDir, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(homeDir, 'AppData', 'Local');
}

process.env.PI_DESKTOP_USER_DATA_DIR = userDataDir;
delete process.env.PI_DESKTOP_WORKSPACE;
// Both actual engines consume PI_CODING_AGENT_DIR. Keep the app's OMP session
// index in the corresponding private OMP tree rather than inheriting a root.
process.env.PI_CODING_AGENT_DIR = piAgentDir;
process.env.OMP_CODING_AGENT_DIR = ompAgentDir;

app.setPath('appData', process.platform === 'win32' ? process.env.APPDATA : xdgConfigDir);
app.setPath('home', homeDir);
app.setPath('userData', userDataDir);
app.setPath('sessionData', sessionDir);

console.log('=================================================================');
console.log('[HARNESS] Pi Desktop Quick Chat Native Validation Launcher');
console.log(`[HARNESS] Repo dir:       ${repoDir}`);
console.log(`[HARNESS] Artifacts dir:  ${artifactsDir}`);
console.log(`[HARNESS] Private root:   ${sandboxRoot}`);
console.log(`[HARNESS] Platform:       ${process.platform} (${process.arch})`);
console.log(`[HARNESS] Electron:       ${process.versions.electron}`);
console.log(`[HARNESS] Embedded Node:  ${process.version}`);
if (process.env.WAYLAND_DISPLAY) {
  console.log(`[HARNESS] Wayland socket: ${process.env.WAYLAND_DISPLAY}`);
} else if (process.env.DISPLAY) {
  console.log(`[HARNESS] X11 display:    ${process.env.DISPLAY}`);
}
console.log('=================================================================');

// Minimal settings override: only the opt-in Quick Chat hotkey, no duplicate defaults
const minimalSettings = {
  language: 'en',
  shortcuts: {
    quickChat: 'Mod+Alt+Q',
  },
};

fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(minimalSettings, null, 2), 'utf8');

// ─── 3. Global Shortcut Observability (No Fake Key Callbacks) ────────────────

const shortcutStats = {
  accelerator: process.platform === 'darwin' ? 'CommandOrControl+Alt+Q' : 'Control+Alt+Q',
  registered: false,
  registrationAttempted: false,
  triggerCount: 0,
  lastTriggerTime: 0,
  honestStatusReason: null,
};

const originalRegister = globalShortcut.register.bind(globalShortcut);
const originalUnregister = globalShortcut.unregister.bind(globalShortcut);

globalShortcut.register = function (accelerator, callback) {
  shortcutStats.registrationAttempted = true;
  shortcutStats.accelerator = accelerator;

  // Genuine counter hook: increments when the OS message pump fires RegisterHotKey / XGrabKey
  const wrappedCallback = (...cbArgs) => {
    shortcutStats.triggerCount++;
    shortcutStats.lastTriggerTime = Date.now();
    console.log(`[HARNESS] Genuine OS Global Shortcut triggered! Accelerator: ${accelerator}, count: ${shortcutStats.triggerCount}`);
    return callback(...cbArgs);
  };

  let res = false;
  try {
    res = originalRegister(accelerator, wrappedCallback);
  } catch (err) {
    shortcutStats.honestStatusReason = `register threw: ${err.message}`;
  }

  shortcutStats.registered = res;
  if (!res && !shortcutStats.honestStatusReason) {
    shortcutStats.honestStatusReason = 'globalShortcut.register returned false';
  }

  console.log(`[HARNESS] globalShortcut.register("${accelerator}") returned ${res}`);
  return res;
};

// ─── 4. Window & Menu Tracking ───────────────────────────────────────────────

let mainWindow = null;
let quickChatWindow = null;
let currentAppMenu = null;
let closeQuickChatOnNextNavigation = false;

const originalSetApplicationMenu = Menu.setApplicationMenu.bind(Menu);
Menu.setApplicationMenu = function (menu) {
  currentAppMenu = menu;
  return originalSetApplicationMenu(menu);
};

const windowDiagnostics = [];
const trackedWindows = new WeakSet();

function recordWindowDiagnostic(tag, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    tag,
    ...details,
  };
  windowDiagnostics.push(entry);
}

function attachQuickChatDiagnostics(win) {
  if (!win || win.isDestroyed() || trackedWindows.has(win)) return;
  trackedWindows.add(win);

  recordWindowDiagnostic('attached', {
    url: win.webContents ? win.webContents.getURL() : '',
    isVisible: win.isVisible(),
    isFocused: win.isFocused(),
  });

  win.on('ready-to-show', () => {
    recordWindowDiagnostic('ready-to-show', {
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
    });
  });

  win.on('show', () => {
    recordWindowDiagnostic('show', {
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
    });
  });

  win.on('hide', () => {
    recordWindowDiagnostic('hide', {
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
    });
  });

  win.on('focus', () => {
    recordWindowDiagnostic('focus', {
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
    });
  });

  win.on('blur', () => {
    recordWindowDiagnostic('blur', {
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
    });
  });

  win.on('unresponsive', () => {
    recordWindowDiagnostic('unresponsive', {
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
    });
  });

  const wc = win.webContents;
  if (wc) {
    wc.on('did-start-loading', () => {
      recordWindowDiagnostic('did-start-loading', {
        url: wc.getURL(),
        isLoading: wc.isLoading(),
      });
    });

    wc.on('did-finish-load', () => {
      recordWindowDiagnostic('did-finish-load', {
        url: wc.getURL(),
        isLoading: wc.isLoading(),
      });
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      recordWindowDiagnostic('did-fail-load', {
        errorCode,
        errorDescription,
        validatedURL,
      });
    });

    wc.on('console-message', (_event, level, message) => {
      const boundedText = typeof message === 'string' ? message.slice(0, 200) : String(message);
      recordWindowDiagnostic('console-message', {
        level,
        message: boundedText,
      });
    });

    wc.on('render-process-gone', (_event, details) => {
      recordWindowDiagnostic('render-process-gone', {
        reason: details ? details.reason : 'unknown',
        exitCode: details ? details.exitCode : 'unknown',
      });
    });
  }
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-start-navigation', (_e, url) => {
    checkWindowIdentity(win, url);
  });
  win.webContents.on('did-navigate', (_e, url) => {
    checkWindowIdentity(win, url);
  });
  checkWindowIdentity(win, win.webContents.getURL());
});

function checkWindowIdentity(win, url) {
  if (url && url.includes('#quick-chat')) {
    quickChatWindow = win;
    console.log('[HARNESS] Identified Quick Chat window!');
    attachQuickChatDiagnostics(win);
    if (closeQuickChatOnNextNavigation) {
      closeQuickChatOnNextNavigation = false;
      recordWindowDiagnostic('regression-close-before-finish-load', { url });
      win.close();
    }
  } else if (!mainWindow && win !== quickChatWindow) {
    mainWindow = win;
    console.log('[HARNESS] Identified Main window!');
    for (const event of ['ready-to-show', 'show', 'focus', 'blur']) {
      win.on(event, () => recordWindowDiagnostic(`main:${event}`, {
        isVisible: win.isVisible(),
        isFocused: win.isFocused(),
      }));
    }
  }
}

function findQuickChatMenuItem(menu = currentAppMenu) {
  if (!menu) return null;
  for (const item of menu.items) {
    if (item.label && (item.label.includes('Quick Chat') || item.label.includes('quick-chat'))) {
      return item;
    }
    if (item.submenu) {
      const found = findQuickChatMenuItem(item.submenu);
      if (found) return found;
    }
  }
  return null;
}

// ─── 5. Harness Context Interface (Zero Source Imports) ──────────────────────

const appContext = {
  artifactsDir,
  getMainWindow: () => mainWindow,
  getQuickChatWindow: () => quickChatWindow,
  getShortcutStats: () => ({ ...shortcutStats }),
  getWindowDiagnostics: () => [...windowDiagnostics],
  getNativeDialogs: () => nativeDialogs.map((entry) => ({ ...entry })),
  armCloseQuickChatBeforeFirstLoad: () => {
    if (quickChatWindow && !quickChatWindow.isDestroyed()) {
      throw new Error('Early-close regression requires a new Quick Chat window');
    }
    closeQuickChatOnNextNavigation = true;
  },
  findQuickChatMenuItem: () => findQuickChatMenuItem(),
  toggleQuickChat: () => {
    const item = findQuickChatMenuItem();
    if (!item) {
      throw new Error('Quick Chat Application Menu item is missing');
    }
    item.click();
  },
};

// ─── 6. Load Built App & Await Explicit Readiness ────────────────────────────

const builtIndexPath = path.join(repoDir, 'out/main/index.js');
if (!fs.existsSync(builtIndexPath)) {
  console.error(`[HARNESS] Error: Built entry point not found at ${builtIndexPath}. Run "npm run build" first.`);
  process.exit(1);
}

console.log(`[HARNESS] Requiring built main module: ${builtIndexPath}`);
require(builtIndexPath);

app.whenReady().then(async () => {
  console.log('[HARNESS] Electron app whenReady resolved. Awaiting mainWindow finish-load...');

  // 1. Wait for mainWindow to be created and finish loading
  const startWait = Date.now();
  while (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    if (Date.now() - startWait > 15000) {
      console.error('[HARNESS] Timeout waiting for mainWindow finish-load');
      app.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('[HARNESS] Main window finished loading.');
  if (!process.env.WAYLAND_DISPLAY) {
    // Startup's deferred main-window show/focus must finish before a global
    // shortcut opens the popup; otherwise startup itself hides that popup.
    const startNativeWait = Date.now();
    while (!mainWindow.isVisible() || !mainWindow.isFocused()) {
      if (Date.now() - startNativeWait > 15000) {
        throw new Error('Main window did not become natively visible and focused before validation');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  console.log(`[HARNESS] Native main-window readiness: visible=${mainWindow.isVisible()}, focused=${mainWindow.isFocused()}`);

  // 2. Wait for settings to settle and global shortcut registration to occur
  const startShortcutWait = Date.now();
  while (!shortcutStats.registrationAttempted) {
    if (Date.now() - startShortcutWait > 8000) {
      console.warn('[HARNESS] Startup settings did not attempt shortcut registration within 8s');
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log('[HARNESS] App readiness verified.');

  const { ValidationRunner } = require('./scenarios.cjs');
  const runner = new ValidationRunner(appContext);

  try {
    const results = await runner.runAll();
    let reportPersistError = null;

    function persistReport(stage) {
      try {
        fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
        console.log(`[HARNESS] Validation report persisted to ${reportPath} (${stage})`);
      } catch (err) {
        reportPersistError = err;
        console.error(`[HARNESS] Error: Failed to persist report at stage "${stage}":`, err);
      }
    }

    persistReport('initial');

    console.log('=================================================================');
    console.log(`[HARNESS] SCENARIOS SUMMARY (${results.overallStatus}):`);
    for (const [name, res] of Object.entries(results.scenarios)) {
      console.log(`  - ${name.padEnd(45)}: ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
    }
    console.log('=================================================================');

    const hasScenarioFailure = Object.values(results.scenarios || {}).some(
      (s) => s.status === 'FAIL' || s.status === 'ERROR' || s.status === 'PENDING'
    );
    const isFailure =
      results.overallStatus === 'FAIL' ||
      results.overallStatus === 'ERROR' ||
      (results.overallStatus !== 'PASS' && results.overallStatus !== 'PARTIAL') ||
      hasScenarioFailure;

    let teardownTimer = null;

    // Natural quit lifecycle verification
    console.log('[HARNESS] Initiating real app.quit() teardown...');
    app.on('will-quit', () => {
      console.log('[HARNESS] Observed real will-quit event!');
      results.teardown = results.teardown || {};
      results.teardown.willQuitObserved = true;
      persistReport('will-quit');
    });
    app.on('quit', (_event, exitCode) => {
      console.log(`[HARNESS] Observed real quit event with exit code: ${exitCode}!`);
      clearTimeout(teardownTimer);
      results.teardown = results.teardown || {};
      results.teardown.quitObserved = true;
      results.teardown.quitExitCode = exitCode;
      persistReport('quit');

      if (isFailure || reportPersistError) {
        console.error(
          `[HARNESS] Validation finished with failure (status: ${results.overallStatus}, persistError: ${Boolean(
            reportPersistError
          )}). Terminating with exit code 1.`
        );
        app.exit(1);
      }
    });

    // Safety timeout: ALWAYS exit 1 on hang, regardless of test pass status
    teardownTimer = setTimeout(() => {
      console.error('[HARNESS] Teardown safety timeout reached after 10s. Forcing exit 1.');
      app.exit(1);
    }, 10000);

    app.quit();
  } catch (err) {
    console.error('[HARNESS] Fatal scenario error:', err);
    try {
      if (!fs.existsSync(reportPath)) {
        fs.writeFileSync(
          reportPath,
          JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              overallStatus: 'FAIL',
              error: err.stack || err.message,
              platform: {
                os: process.platform,
                arch: process.arch,
                displayServer: process.env.WAYLAND_DISPLAY
                  ? 'wayland'
                  : process.env.DISPLAY
                  ? 'x11'
                  : process.platform === 'win32'
                  ? 'windows'
                  : 'darwin',
              },
              scenarios: {},
            },
            null,
            2
          ),
          'utf8'
        );
      }
    } catch (writeErr) {
      console.error('[HARNESS] Failed to write fallback report:', writeErr);
    }
    app.exit(1);
  }
}).catch((err) => {
  console.error('[HARNESS] Fatal initialization error in app.whenReady:', err);
  app.exit(1);
});
