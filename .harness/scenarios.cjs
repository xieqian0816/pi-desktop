/**
 * Platform validation scenarios for Pi Desktop Quick Chat.
 *
 * Runs actual native scenarios on built main/preload/renderer:
 * 1. Shortcut Open / Hide / Reopen (real OS hotkey, fail-closed on Win/Mac/X11, honest Wayland detection)
 * 2. Menu Handler Toggle (actual menu handler, not simulated OS menu interaction)
 * 3. Settings > Keyboard Shortcuts > Open Quick Chat (real visible Settings button)
 * 4. Pin vs Blur (blur auto-hide vs pinned same-app-focus retention & alwaysOnTop)
 * 5. Display-Aware Bounds (workArea clamping & dimensions)
 * 6. Draft Visible During Model Selection & No Native Resize (layout collision check, bounds equality, Escape dismiss)
 * 7. Sandbox and Navigation Deny (will-navigate defaultPrevented check, renderer-initiated location assign, require/process undefined)
 * 8. Quit Lifecycle & Native Unsaved-Editor Guard (early-close no-reopen, real dirty editor, native dialog cancellation)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { screen, BrowserWindow, Menu, app } = require('electron');
const { injectNativeHotkey, injectNativeEscape, inspectWaylandPortalCapability, inspectNativeWindowsModal } = require('./os-input-injector.cjs');
const { CdpHelper, captureWindowScreenshot } = require('./cdp-helper.cjs');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDeadline(promise, timeoutMs, operation) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Awaits until async predicate resolves to truthy, fail-closed with timeout error.
 */
async function waitForCondition(predicate, timeoutMs = 8000, intervalMs = 50, failureMessage = 'Timeout waiting for condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let res = false;
    try {
      res = await predicate();
    } catch {
      res = false;
    }
    if (Boolean(res)) return res;
    await sleep(intervalMs);
  }
  throw new Error(`${failureMessage} (exceeded ${timeoutMs}ms)`);
}

/** Record native visibility/focus transitions without changing window behavior. */
function createDiagnosticTracker(ctx, logFn) {
  const observations = [];
  const listeners = new Map();
  const mainWin = ctx.getMainWindow();

  const record = (tag) => {
    const win = ctx.getQuickChatWindow();
    const live = win && !win.isDestroyed();
    const focused = BrowserWindow.getFocusedWindow();
    const observation = {
      timestamp: new Date().toISOString(),
      tag,
      isVisible: Boolean(live && win.isVisible()),
      isFocused: Boolean(live && win.isFocused()),
      focusedWindow: !focused ? 'none' : focused === win ? 'quickChat' : focused === mainWin ? 'mainWindow' : `win#${focused.id}`,
      triggerCount: ctx.getShortcutStats().triggerCount,
    };
    observations.push(observation);
    logFn(`[obs:${tag}] visible=${observation.isVisible} focused=${observation.isFocused} focusedWin=${observation.focusedWindow} triggers=${observation.triggerCount}`);
  };

  const attachToWindow = (win) => {
    if (!win || win.isDestroyed() || listeners.has(win)) return;
    const handlers = new Map();
    for (const event of ['show', 'hide', 'focus', 'blur']) {
      const handler = () => record(`popup:${event}`);
      handlers.set(event, handler);
      win.on(event, handler);
    }
    listeners.set(win, handlers);
  };

  return {
    record,
    attachToWindow,
    getObservations: () => observations,
    dispose: () => {
      for (const [win, handlers] of listeners) {
        if (!win.isDestroyed()) for (const [event, handler] of handlers) win.removeListener(event, handler);
      }
      listeners.clear();
    },
  };
}

class ValidationRunner {
  constructor(ctx) {
    this.ctx = ctx;
    this.artifactsDir = ctx.artifactsDir;
    this.screenshotsDir = path.join(ctx.artifactsDir, 'screenshots');
    this.results = {
      timestamp: new Date().toISOString(),
      platform: {
        os: process.platform,
        arch: process.arch,
        release: require('os').release(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        displayServer: process.env.WAYLAND_DISPLAY
          ? 'wayland'
          : (process.env.DISPLAY ? 'x11' : (process.platform === 'win32' ? 'windows' : 'darwin')),
        isWayland: Boolean(process.env.WAYLAND_DISPLAY),
        ciLimitations: {
          noSandbox: app.commandLine.hasSwitch('no-sandbox'),
          headlessCompositor: Boolean(process.env.WAYLAND_DISPLAY),
        },
      },
      shortcutObservation: null,
      scenarios: {},
      screenshots: [],
      overallStatus: 'PENDING',
    };
  }

  log(msg) {
    console.log(`[VALIDATION] ${msg}`);
  }

  async captureScenarioScreenshot(win, name) {
    const shotPath = path.join(this.screenshotsDir, `${name}.png`);
    try {
      const shot = await withDeadline(captureWindowScreenshot(win, shotPath), 5000, `Screenshot ${name}`);
      this.results.screenshots.push({ name, ...shot });
      this.results.platform.ciLimitations.screenshots = this.results.platform.ciLimitations.screenshots || [];
      this.results.platform.ciLimitations.screenshots.push({ name, status: 'CAPTURED' });
      return true;
    } catch (error) {
      if (!this.results.platform.isWayland || !String(error.message).includes('UnknownVizError')) throw error;
      const limitation = { name, status: 'UNSUPPORTED', error: error.message };
      this.results.platform.ciLimitations.screenshots = this.results.platform.ciLimitations.screenshots || [];
      this.results.platform.ciLimitations.screenshots.push(limitation);
      this.log(`Native Wayland screenshot unavailable for ${name}: ${error.message}; DOM and native bounds evidence retained.`);
      return false;
    }
  }

  async captureTimeoutDiagnosticSnapshot(scenarioName, err) {
    const isTimeout =
      err && typeof err.message === 'string' && (err.message.includes('exceeded') || err.message.includes('Timeout'));
    if (!isTimeout) return null;

    this.log(`Capturing diagnostic snapshot on timeout for scenario "${scenarioName}"...`);
    const qcWin = this.ctx.getQuickChatWindow();
    const snapshot = {
      timestamp: new Date().toISOString(),
      scenario: scenarioName,
      error: err.message,
      windowExists: Boolean(qcWin),
      windowDestroyed: Boolean(qcWin && qcWin.isDestroyed()),
      isVisible: Boolean(qcWin && !qcWin.isDestroyed() && qcWin.isVisible()),
      isFocused: Boolean(qcWin && !qcWin.isDestroyed() && qcWin.isFocused()),
      windowDiagnostics: typeof this.ctx.getWindowDiagnostics === 'function' ? this.ctx.getWindowDiagnostics() : [],
    };

    if (qcWin && !qcWin.isDestroyed()) {
      const wc = qcWin.webContents;
      if (wc && !wc.isDestroyed()) {
        snapshot.isLoading = wc.isLoading();
        snapshot.url = wc.getURL();

        try {
          const cdp = new CdpHelper(wc);
          await withDeadline(cdp.attach(), 2000, 'Diagnostic CDP attach');
          try {
            const domState = await withDeadline(cdp.evaluate(`(() => {
              const root = document.getElementById('root') || document.body;
              const errorEl = document.querySelector('.error, [role="alert"], pre');
              return {
                readyState: document.readyState,
                visibilityState: document.visibilityState,
                title: document.title,
                bodyInnerText: (document.body ? document.body.innerText : '').slice(0, 300),
                rootChildCount: root ? root.children.length : 0,
                errorText: errorEl ? errorEl.innerText.slice(0, 300) : null,
              };
            })()`), 2000, 'Diagnostic DOM evaluation');
            snapshot.domState = domState;
          } finally {
            await cdp.detach();
          }
        } catch (cdpErr) {
          snapshot.domState = { cdpError: cdpErr.message };
        }
      }

      try {
        fs.mkdirSync(this.screenshotsDir, { recursive: true });
        const shotPath = path.join(this.screenshotsDir, `failure-${scenarioName}.png`);
        const shot = await withDeadline(captureWindowScreenshot(qcWin, shotPath), 2000, 'Diagnostic screenshot');
        snapshot.screenshotPath = shot.path;
        this.results.screenshots.push({ name: `failure-${scenarioName}`, path: shot.path });
      } catch (shotErr) {
        snapshot.screenshotError = shotErr.message;
      }
    }

    return snapshot;
  }

  async runAll() {
    this.log('Starting native platform validation suite...');
    try {
      this.currentScenario = 'shortcutOpenHideReopen';
      await this.scenario1_ShortcutOpenHideReopen();
      this.currentScenario = 'menuHandlerToggle';
      await this.scenario2_MenuHandlerToggle();
      this.currentScenario = 'settingsQuickChatButton';
      await this.scenario3_SettingsQuickChatButton();
      this.currentScenario = 'pinVsBlur';
      await this.scenario4_PinVsBlur();
      this.currentScenario = 'displayAwareBounds';
      await this.scenario5_DisplayAwareBounds();
      this.currentScenario = 'draftVisibleDuringModelSelectionNoResize';
      await this.scenario6_DraftVisibleDuringModelSelectionNoResize();
      this.currentScenario = 'sandboxAndNavigationDeny';
      await this.scenario7_SandboxAndNavigationDeny();
      this.currentScenario = 'quitLifecycle';
      await this.scenario8_QuitLifecycleAndUnsavedEditorGuard();
      this.currentScenario = null;

      const statuses = Object.values(this.results.scenarios).map((s) => s.status);
      const hasFailed = statuses.includes('FAIL') || statuses.includes('ERROR');
      const hasUnsupported = statuses.includes('UNSUPPORTED');

      if (hasFailed) {
        this.results.overallStatus = 'FAIL';
      } else if (hasUnsupported) {
        this.results.overallStatus = 'PARTIAL';
      } else {
        this.results.overallStatus = 'PASS';
      }

      this.log(`Validation suite finished: ${this.results.overallStatus}`);
    } catch (err) {
      this.log(`Validation suite encountered fatal error: ${err.stack || err.message}`);
      this.results.overallStatus = 'FAIL';
      this.results.error = err.message;
      try {
        const snapshot = await this.captureTimeoutDiagnosticSnapshot(this.currentScenario || 'suite', err);
        if (snapshot) {
          this.results.failureDiagnosticSnapshot = snapshot;
          if (this.currentScenario && this.results.scenarios[this.currentScenario]) {
            this.results.scenarios[this.currentScenario].failureDiagnosticSnapshot = snapshot;
          }
        }
      } catch (diagErr) {
        this.log(`Failed to capture timeout diagnostic snapshot: ${diagErr.message}`);
      }
    }
    this.results.shortcutObservation = { ...this.ctx.getShortcutStats() };
    return this.results;
  }

  /**
   * Scenario 1: Genuine Native OS Shortcut Open / Hide / Reopen
   */
  async scenario1_ShortcutOpenHideReopen() {
    this.log('--- Scenario 1: Native OS Shortcut Open / Hide / Reopen ---');
    const shortcutStats = this.ctx.getShortcutStats();
    this.results.shortcutObservation = { ...shortcutStats };

    if (!shortcutStats.registered) {
      if (this.results.platform.isWayland) {
        // Native Wayland: probe D-Bus capability honestly via Introspect
        const portalCap = inspectWaylandPortalCapability();
        this.log(`Wayland GlobalShortcuts portal status: ${JSON.stringify(portalCap)}`);
        this.results.scenarios.shortcutOpenHideReopen = {
          status: 'UNSUPPORTED',
          reason: 'globalShortcut.register returned false on Wayland',
          portalBackendCondition: 'unverified',
          actualPortalIntrospection: portalCap,
        };
        this.log('Wayland shortcut registration recorded as UNSUPPORTED; portal backend/identity/consent condition unverified.');
        return;
      }

      // Windows, Linux X11, macOS: failure to register shortcut is a real FAIL
      this.results.scenarios.shortcutOpenHideReopen = {
        status: 'FAIL',
        reason: `globalShortcut.register returned false on ${this.results.platform.os}`,
      };
      throw new Error(`Global shortcut failed to register on ${this.results.platform.os}`);
    }

    const tracker = createDiagnosticTracker(this.ctx, (msg) => this.log(msg));
    try {
      this.log(`Shortcut "${shortcutStats.accelerator}" registered. Injecting native OS keystroke...`);
      let previousTriggers = shortcutStats.triggerCount;
      tracker.record('s1:start');

      // 1. Inject hotkey -> Window should become visible and trigger counter must increment
      tracker.record('s1:before-inject-1');
      const inject1 = await injectNativeHotkey(shortcutStats.accelerator);
      tracker.record('s1:after-inject-1');
      if (!inject1.success) {
        if (this.results.platform.isWayland) {
          const portalCap = inspectWaylandPortalCapability();
          this.results.scenarios.shortcutOpenHideReopen = {
            status: 'UNSUPPORTED',
            reason: `Wayland input injection unsupported: ${inject1.error}`,
            portalBackendCondition: 'unverified',
            actualPortalIntrospection: portalCap,
            diagnosticObservations: tracker.getObservations(),
          };
          this.log(`Wayland shortcut injection recorded as UNSUPPORTED: ${inject1.error}`);
          return;
        }
        this.results.scenarios.shortcutOpenHideReopen = {
          status: 'FAIL',
          error: inject1.error,
          diagnosticObservations: tracker.getObservations(),
        };
        throw new Error(`OS Keystroke injection #1 failed: ${inject1.error}`);
      }

      await waitForCondition(() => {
        const w = this.ctx.getQuickChatWindow();
        const currentStats = this.ctx.getShortcutStats();
        return w && !w.isDestroyed() && w.isVisible() && currentStats.triggerCount > previousTriggers;
      }, 8000, 50, 'Quick Chat window did not open via native OS hotkey injection #1');

      previousTriggers = this.ctx.getShortcutStats().triggerCount;
      const qcWin = this.ctx.getQuickChatWindow();
      tracker.attachToWindow(qcWin);
      this.log(`Quick Chat window opened via native OS hotkey! Counter: ${previousTriggers}`);
      tracker.record('s1:after-open-resolved');

      // Wait for the real popup UI before capturing evidence; native visibility
      // alone does not prove that the renderer has produced its first frame.
      const screenshotCdp = new CdpHelper(qcWin.webContents);
      await screenshotCdp.waitForSelector('textarea', 5000);
      await screenshotCdp.detach();
      await this.captureScenarioScreenshot(qcWin, '01-quick-chat-opened');

      // 2. Inject hotkey again -> Window should hide and counter increment
      // Explicit bounded wait for qcWin visible AND focused
      // Request focus once; do not repeatedly override the native blur behavior.
      if (qcWin && !qcWin.isDestroyed()) qcWin.focus();
      await waitForCondition(() => {
        const w = this.ctx.getQuickChatWindow();
        return Boolean(w && !w.isDestroyed() && w.isVisible() && BrowserWindow.getFocusedWindow() === w);
      }, 4000, 50, 'Quick Chat window was not visible and focused before second hotkey injection');

      tracker.record('s1:before-inject-2');
      const inject2 = await injectNativeHotkey(shortcutStats.accelerator);
      tracker.record('s1:after-inject-2');
      if (!inject2.success) throw new Error(`OS Keystroke injection #2 failed: ${inject2.error}`);

      await waitForCondition(() => {
        const w = this.ctx.getQuickChatWindow();
        const currentStats = this.ctx.getShortcutStats();
        return (!w || w.isDestroyed() || !w.isVisible()) && currentStats.triggerCount > previousTriggers;
      }, 8000, 50, 'Quick Chat window did not hide via native OS hotkey injection #2');

      previousTriggers = this.ctx.getShortcutStats().triggerCount;
      this.log(`Quick Chat window hid via native OS hotkey! Counter: ${previousTriggers}`);
      tracker.record('s1:after-hide-resolved');

      // 3. Inject hotkey 3rd time -> Window should reopen and counter increment
      await sleep(300);
      tracker.record('s1:before-inject-3');
      const inject3 = await injectNativeHotkey(shortcutStats.accelerator);
      tracker.record('s1:after-inject-3');
      if (!inject3.success) throw new Error(`OS Keystroke injection #3 failed: ${inject3.error}`);

      await waitForCondition(() => {
        const w = this.ctx.getQuickChatWindow();
        const currentStats = this.ctx.getShortcutStats();
        return w && !w.isDestroyed() && w.isVisible() && currentStats.triggerCount > previousTriggers;
      }, 8000, 50, 'Quick Chat window did not reopen via native OS hotkey injection #3');

      previousTriggers = this.ctx.getShortcutStats().triggerCount;
      this.log(`Quick Chat window reopened via native OS hotkey! Counter: ${previousTriggers}`);
      tracker.record('s1:after-reopen-resolved');
      this.results.shortcutObservation = { ...this.ctx.getShortcutStats() };
      this.results.scenarios.shortcutOpenHideReopen = {
        status: 'PASS',
        mode: 'native-os-hotkey',
        accelerator: shortcutStats.accelerator,
        totalVerifiedTriggers: previousTriggers,
        diagnosticObservations: tracker.getObservations(),
      };
    } finally {
      if (!this.results.scenarios.shortcutOpenHideReopen) {
        this.results.scenarios.shortcutOpenHideReopen = { status: 'FAIL' };
      }
      this.results.scenarios.shortcutOpenHideReopen.diagnosticObservations = tracker.getObservations();
      tracker.dispose();
    }
  }

  /**
   * Scenario 2: Application Menu Handler Toggle (Handler-Only)
   */
  async scenario2_MenuHandlerToggle() {
    this.log('--- Scenario 2: Application Menu Handler Toggle (Handler-Only) ---');
    const menuItem = this.ctx.findQuickChatMenuItem();
    if (!menuItem) {
      this.results.scenarios.menuHandlerToggle = {
        status: 'FAIL',
        reason: 'Quick Chat application menu entry is required',
      };
      throw new Error('Quick Chat application menu entry is missing');
    }

    const tracker = createDiagnosticTracker(this.ctx, (msg) => this.log(msg));
    try {
      tracker.record('s2:start');
      const qcWin = this.ctx.getQuickChatWindow();
      const initiallyVisible = Boolean(qcWin && !qcWin.isDestroyed() && qcWin.isVisible());
      const targetDirection1 = !initiallyVisible;

      // Toggle via menu click (Direction 1)
      tracker.record('s2:before-menu-click-1');
      menuItem.click();
      tracker.record('s2:after-menu-click-1');

      await waitForCondition(() => {
        const w = this.ctx.getQuickChatWindow();
        tracker.attachToWindow(w);
        return Boolean(w && !w.isDestroyed() && w.isVisible()) === targetDirection1;
      }, 6000, 50, 'Application menu item click did not toggle Quick Chat window visibility');

      tracker.record('s2:after-direction-1-resolved');

      // Toggle back (Direction 2)
      tracker.record('s2:before-menu-click-2');
      menuItem.click();
      tracker.record('s2:after-menu-click-2');

      await waitForCondition(() => {
        const w = this.ctx.getQuickChatWindow();
        const isVis = Boolean(w && !w.isDestroyed() && w.isVisible());
        return isVis === initiallyVisible;
      }, 6000, 50, 'Application menu item click did not toggle Quick Chat window back');

      tracker.record('s2:after-direction-2-resolved');

      this.results.scenarios.menuHandlerToggle = {
        status: 'PASS',
        handlerOnly: true,
        menuItemLabel: menuItem.label,
        diagnosticObservations: tracker.getObservations(),
      };
      this.log('Verified Application Menu handler-only toggle!');
    } finally {
      if (!this.results.scenarios.menuHandlerToggle) {
        this.results.scenarios.menuHandlerToggle = { status: 'FAIL' };
      }
      this.results.scenarios.menuHandlerToggle.diagnosticObservations = tracker.getObservations();
      tracker.dispose();
    }
  }

  /**
   * Scenario 3: Visible Settings UI Fallback (Open Settings via Cmd/Ctrl+, > Keyboard shortcuts > Open Quick Chat button)
   */
  async scenario3_SettingsQuickChatButton() {
    this.log('--- Scenario 3: Settings > Keyboard Shortcuts > Open Quick Chat Button ---');
    const mainWin = this.ctx.getMainWindow();
    if (!mainWin || mainWin.isDestroyed()) {
      throw new Error('Main window required for Settings Quick Chat button test');
    }

    // Ensure Quick Chat is hidden initially
    const qcWin = this.ctx.getQuickChatWindow();
    if (qcWin && !qcWin.isDestroyed() && qcWin.isVisible()) {
      qcWin.hide();
      await waitForCondition(() => !qcWin.isVisible(), 3000, 50, 'Could not hide Quick Chat window before Settings test');
    }

    // Focus main window
    mainWin.focus();
    await sleep(200);

    const mainCdp = new CdpHelper(mainWin.webContents);
    await mainCdp.attach();

    // Open Settings via native local key Cmd+, (macOS) or Ctrl+, (Windows/Linux)
    const isMac = process.platform === 'darwin';
    this.log(`Dispatching ${isMac ? 'Cmd+Comma' : 'Ctrl+Comma'} to open Settings...`);
    await mainCdp.evaluate(`
      (() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: ',',
          code: 'Comma',
          keyCode: 188,
          metaKey: ${isMac},
          ctrlKey: ${!isMac},
          bubbles: true,
          cancelable: true,
        }));
        return true;
      })()
    `);

    // Directly locate and click the exact "Open Quick Chat" button in the Settings page
    this.log('Locating and clicking exact "Open Quick Chat" button...');
    const findAndClickBtn = async () => {
      return mainCdp.evaluate(`
        (() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const btn = buttons.find((b) => {
            const txt = b.textContent?.trim() || '';
            const aria = b.getAttribute('aria-label') || '';
            return txt === 'Open Quick Chat' || aria === 'Open Quick Chat' || txt.includes('Open Quick Chat');
          });
          if (btn) {
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            return true;
          }
          return false;
        })()
      `);
    };

    await waitForCondition(findAndClickBtn, 8000, 100, 'Could not find or click exact "Open Quick Chat" button in Settings');
    this.log('Clicked exact "Open Quick Chat" button in Settings');

    // Assert Quick Chat popup is now visible!
    await waitForCondition(() => {
      const w = this.ctx.getQuickChatWindow();
      return w && !w.isDestroyed() && w.isVisible();
    }, 6000, 50, 'Quick Chat popup window did not open after clicking "Open Quick Chat" button in Settings');

    this.log('Verified: Quick Chat popup window opened via visible Settings button!');

    this.results.scenarios.settingsQuickChatButton = {
      status: 'PASS',
      mode: 'ui-settings-open-quick-chat-button',
      localShortcut: isMac ? 'Cmd+Comma' : 'Ctrl+Comma',
      popupVisible: true,
    };
  }

  /**
   * Scenario 4: Pin vs Blur
   */
  async scenario4_PinVsBlur() {
    this.log('--- Scenario 4: Pin vs Blur ---');
    let qcWin = this.ctx.getQuickChatWindow();
    if (!qcWin || !qcWin.isVisible()) {
      this.ctx.toggleQuickChat();
      await waitForCondition(() => {
        const w = this.ctx.getQuickChatWindow();
        return w && !w.isDestroyed() && w.isVisible();
      }, 5000, 50, 'Could not open Quick Chat for Pin vs Blur scenario');
      qcWin = this.ctx.getQuickChatWindow();
    }

    const cdp = new CdpHelper(qcWin.webContents);
    await cdp.attach();

    const mainWin = this.ctx.getMainWindow();

    if (this.results.platform.isWayland) {
      // Weston headless has no user-driven keyboard activation. Do not equate
      // an already-unfocused window with a focus -> blur transition.
      const focusEvidence = { initialFocused: qcWin.isFocused() };
      qcWin.focus();
      await sleep(200);
      focusEvidence.focusedAfterFocusRequest = qcWin.isFocused();
      let blurObserved = false;
      const onBlur = () => { blurObserved = true; };
      qcWin.once('blur', onBlur);
      qcWin.blur();
      await sleep(200);
      qcWin.removeListener('blur', onBlur);
      focusEvidence.blurObserved = blurObserved;
      focusEvidence.focusedAfterBlurRequest = qcWin.isFocused();
      focusEvidence.focusedWindow = BrowserWindow.getFocusedWindow()?.id ?? null;
      if (!focusEvidence.focusedAfterFocusRequest) {
        if (qcWin.isVisible()) this.ctx.toggleQuickChat();
        await waitForCondition(() => !qcWin.isVisible(), 4000, 50,
          'Could not restore hidden state after Wayland focus capability probe');
        this.results.scenarios.pinVsBlur = {
          status: 'UNSUPPORTED',
          reason: 'Native Wayland compositor did not grant keyboard focus or emit a focus-to-blur transition; pin/blur behavior requires an interactive desktop session',
          nativeFocusEvidence: focusEvidence,
        };
        return;
      }
    }

    const transferFocusAway = async () => {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.focus();
        await waitForCondition(() => BrowserWindow.getFocusedWindow() === mainWin && !qcWin.isFocused(),
          3000, 50, 'Focus did not transfer to main window');
      } else {
        qcWin.blur();
      }
    };

    // 1. Unpinned: focus main window to blur popup -> should auto-hide
    this.log('Testing unpinned auto-hide on blur...');
    await transferFocusAway();

    await waitForCondition(() => !qcWin.isVisible(), 4000, 50, 'Quick Chat did not auto-hide when blurred while unpinned');
    this.log('Quick Chat window auto-hid on blur as expected!');

    // 2. Reopen window
    this.ctx.toggleQuickChat();
    await waitForCondition(() => qcWin.isVisible(), 4000, 50, 'Quick Chat did not reopen after blur');

    // 3. Pin window via CDP DOM click
    this.log('Locating Pin button in DOM...');
    const pinSelector = 'button[aria-label*="Pin" i], button[aria-label*="pin" i], button:has(svg.lucide-pin)';
    await cdp.waitForSelector(pinSelector, 5000);
    await cdp.clickElement(pinSelector);
    await sleep(200);

    // Verify alwaysOnTop property on native window
    const alwaysOnTop = qcWin.isAlwaysOnTop();
    if (!alwaysOnTop) {
      throw new Error('Quick Chat window isAlwaysOnTop is false while pinned');
    }
    this.log(`Verified: qcWin.isAlwaysOnTop is ${alwaysOnTop}`);

    await this.captureScenarioScreenshot(qcWin, '02-quick-chat-pinned');

    // 4. Blur window while pinned -> MUST STAY VISIBLE
    this.log('Blurring window while pinned...');
    await transferFocusAway();

    await sleep(400); // Exceed 120ms debounce
    if (!qcWin.isVisible()) {
      throw new Error('Quick Chat window hid on blur despite being pinned!');
    }
    if (!qcWin.isAlwaysOnTop()) {
      throw new Error('Quick Chat window lost isAlwaysOnTop while pinned!');
    }
    this.log('Quick Chat window remained visible on blur while pinned (same-app focus retention verified)!');

    // 5. Unpin and verify auto-hide resumes
    qcWin.focus();
    await waitForCondition(() => qcWin.isFocused(), 2000, 50, 'Could not focus Quick Chat window before unpin');
    await cdp.clickElement(pinSelector);
    await sleep(200);

    await transferFocusAway();
    await waitForCondition(() => !qcWin.isVisible(), 4000, 50, 'Quick Chat window failed to auto-hide after unpinning');
    this.log('Quick Chat window auto-hid after unpinning!');

    this.results.scenarios.pinVsBlur = {
      status: 'PASS',
      unpinnedBlurHid: true,
      sameAppFocusRetention: true,
      isAlwaysOnTopVerified: true,
      unpinnedResumedHide: true,
    };
  }

  /**
   * Scenario 5: Display-Aware Bounds
   */
  async scenario5_DisplayAwareBounds() {
    this.log('--- Scenario 5: Display-Aware Bounds ---');
    this.ctx.toggleQuickChat();
    const qcWin = this.ctx.getQuickChatWindow();
    await waitForCondition(() => qcWin && qcWin.isVisible(), 5000, 50, 'Quick Chat did not open for bounds test');

    const bounds = qcWin.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const workArea = display.workArea;

    this.log(`Window bounds: ${JSON.stringify(bounds)}, workArea: ${JSON.stringify(workArea)}`);

    const withinX = bounds.x >= workArea.x && (bounds.x + bounds.width) <= (workArea.x + workArea.width);
    const withinY = bounds.y >= workArea.y && (bounds.y + bounds.height) <= (workArea.y + workArea.height);
    const minWidthOk = bounds.width >= Math.min(480, workArea.width);
    const minHeightOk = bounds.height >= Math.min(320, workArea.height);

    if (!withinX || !withinY) {
      throw new Error(`Quick Chat window bounds out of display workArea: ${JSON.stringify(bounds)} vs ${JSON.stringify(workArea)}`);
    }
    if (!minWidthOk || !minHeightOk) {
      throw new Error(
        `Quick Chat window violates minimum dimensions: width=${bounds.width} (minWidthOk=${minWidthOk}), height=${bounds.height} (minHeightOk=${minHeightOk})`
      );
    }

    this.results.scenarios.displayAwareBounds = {
      status: 'PASS',
      bounds,
      workArea,
      withinWorkArea: true,
      minConstraintsRespected: minWidthOk && minHeightOk,
    };
  }

  /**
   * Scenario 6: Draft Visible During Model Selection & No Native Resize
   */
  async scenario6_DraftVisibleDuringModelSelectionNoResize() {
    this.log('--- Scenario 6: Draft Visible During Model Selection & No Native Resize ---');
    let qcWin = this.ctx.getQuickChatWindow();
    if (!qcWin || !qcWin.isVisible()) {
      this.ctx.toggleQuickChat();
      await waitForCondition(() => qcWin && qcWin.isVisible(), 5000, 50, 'Quick Chat window failed to open');
      qcWin = this.ctx.getQuickChatWindow();
    }

    const cdp = new CdpHelper(qcWin.webContents);
    await cdp.attach();

    // 1. Locate textarea and type draft text using genuine CDP Input.insertText
    const textareaSelector = 'textarea';
    await cdp.waitForSelector(textareaSelector, 6000);

    const draftText = 'Verification draft text: must remain visible and not obscured by model picker';
    await cdp.typeInElement(textareaSelector, draftText);
    const typedVal = await cdp.getElementValue(textareaSelector);
    if (typedVal !== draftText) {
      throw new Error(`Draft textarea did not receive typed text. Got: "${typedVal}"`);
    }
    this.log(`Typed draft text into composer: "${draftText}"`);

    // 2. Measure native window bounds BEFORE opening model picker
    const boundsBefore = qcWin.getBounds();

    // 3. Open model picker
    const modelPickerBtnSelector = 'button:has(svg.lucide-cpu), button[title*="model" i], button[title*="Model" i]';
    await cdp.waitForSelector(modelPickerBtnSelector, 5000);
    await cdp.clickElement(modelPickerBtnSelector);
    this.log('Clicked Model Picker trigger button in ActionPills');

    // 4. Wait for ModelPicker popover dialog root to open in DOM (exact role="dialog")
    const popoverSelector = 'div[role="dialog"]';
    await cdp.waitForSelector(popoverSelector, 6000);
    this.log('Model picker popover mounted in DOM (div[role="dialog"])');

    // 5. Measure native window bounds DURING model picker open
    const boundsDuring = qcWin.getBounds();

    // 6. Assert NO native window resize
    const boundsUnchanged =
      boundsDuring.width === boundsBefore.width &&
      boundsDuring.height === boundsBefore.height &&
      boundsDuring.x === boundsBefore.x &&
      boundsDuring.y === boundsBefore.y;

    if (!boundsUnchanged) {
      throw new Error(`Native window resized during model picker open! Before: ${JSON.stringify(boundsBefore)}, During: ${JSON.stringify(boundsDuring)}`);
    }
    this.log('Verified: Native window bounds are strictly identical (NO native resize)!');

    // 7. Assert layout geometry: Draft textarea is visible and NOT obscured/overlapping the picker
    const overlapInfo = await cdp.checkElementOverlap(textareaSelector, popoverSelector);
    if (!overlapInfo) {
      throw new Error('Failed to evaluate DOM geometry collision between textarea and model picker');
    }

    if (!overlapInfo.positiveArea) {
      throw new Error(`Zero/negative geometry on elements: Textarea: ${JSON.stringify(overlapInfo.rectA)}, Picker: ${JSON.stringify(overlapInfo.rectB)}`);
    }
    if (!overlapInfo.inViewport) {
      throw new Error(`Elements rendered outside viewport: Textarea: ${JSON.stringify(overlapInfo.rectA)}, Picker: ${JSON.stringify(overlapInfo.rectB)}`);
    }
    if (overlapInfo.overlap) {
      throw new Error(`Model picker popover overlaps and covers draft textarea! Picker: ${JSON.stringify(overlapInfo.rectB)}, Textarea: ${JSON.stringify(overlapInfo.rectA)}`);
    }
    this.log('Verified: Model picker popover has positive viewport geometry and does NOT overlap draft textarea!');

    // 8. Assert draft text value remains intact
    const draftStillPresent = await cdp.getElementValue(textareaSelector);
    if (draftStillPresent !== draftText) {
      throw new Error(`Draft text lost or altered during model selection! Value: "${draftStillPresent}"`);
    }
    this.log('Verified: Draft textarea content strictly preserved!');

    await this.captureScenarioScreenshot(qcWin, '03-model-picker-open-draft-visible');

    // 9. Close model picker with Escape and verify exact picker removal
    await cdp.dispatchEscapeKey();
    await cdp.waitForSelectorRemoved(popoverSelector, 5000);
    this.log('Model picker popover cleanly dismissed via Escape key');

    // Verify draft text is still present after closing picker
    const draftAfterClose = await cdp.getElementValue(textareaSelector);
    if (draftAfterClose !== draftText) {
      throw new Error(`Draft text lost after closing model picker! Value: "${draftAfterClose}"`);
    }

    this.results.scenarios.draftVisibleDuringModelSelectionNoResize = {
      status: 'PASS',
      boundsBefore,
      boundsDuring,
      noNativeResize: true,
      draftTextPreserved: true,
      positiveGeometry: true,
      inViewport: true,
      textareaBounds: overlapInfo.rectA,
      modelPickerBounds: overlapInfo.rectB,
      noVisualOverlap: true,
      layoutEvidenceOnly: true,
      note: 'Verified layout, bounds preservation, and visibility invariants without fake model completions',
    };
  }

  /**
   * Scenario 7: Sandbox and Navigation Deny
   */
  async scenario7_SandboxAndNavigationDeny() {
    this.log('--- Scenario 7: Sandbox and Navigation Deny ---');
    const qcWin = this.ctx.getQuickChatWindow();
    if (!qcWin || qcWin.isDestroyed()) {
      throw new Error('Quick Chat window must exist for sandbox verification');
    }

    // 1. Inspect the Electron 43.8.3 runtime webPreferences. This inspector is
    // present at runtime despite being absent from the public typings. Missing
    // evidence must fail, never inherit a secure default. With --no-sandbox,
    // these observations do not prove that kernel sandboxing is active.
    if (typeof qcWin.webContents.getLastWebPreferences !== 'function') {
      throw new Error('Electron runtime webPreferences inspector is unavailable; sandbox and isolation remain unobserved');
    }
    const prefs = qcWin.webContents.getLastWebPreferences();
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      throw new Error('Electron runtime webPreferences inspector returned no usable observation');
    }
    const sandboxOk = prefs.sandbox === true;
    const contextIsolationOk = prefs.contextIsolation === true;
    const nodeIntegrationOk = prefs.nodeIntegration === false;

    if (!sandboxOk || !contextIsolationOk || !nodeIntegrationOk) {
      throw new Error(`Observed insecure or incomplete webPreferences: sandbox=${prefs.sandbox}, contextIsolation=${prefs.contextIsolation}, nodeIntegration=${prefs.nodeIntegration}`);
    }
    this.log('Electron runtime webPreferences observed: sandbox=true, contextIsolation=true, nodeIntegration=false');

    const cdp = new CdpHelper(qcWin.webContents);
    await cdp.attach();

    // 2. Verify window.require and process are undefined inside renderer
    const globalsCheck = await cdp.evaluate(`
      (() => ({
        hasRequire: typeof window.require !== 'undefined',
        hasProcess: typeof window.process !== 'undefined',
      }))()
    `);
    if (globalsCheck.hasRequire || globalsCheck.hasProcess) {
      throw new Error(`Node integration leaked into renderer world! hasRequire=${globalsCheck.hasRequire}, hasProcess=${globalsCheck.hasProcess}`);
    }
    this.log('Verified: window.require and window.process are strictly undefined in renderer world');

    // 3. Real renderer-initiated navigation with will-navigate assertion
    let willNavigateObserved = false;
    let willNavigateDefaultPrevented = false;
    const navListener = (e) => {
      willNavigateObserved = true;
      setImmediate(() => {
        willNavigateDefaultPrevented = e.defaultPrevented;
      });
    };
    qcWin.webContents.once('will-navigate', navListener);

    // Trigger navigation from within renderer world
    await cdp.evaluate(`
      (() => {
        try { window.location.href = 'https://example.com/blocked-url-test'; } catch (e) {}
      })()
    `);

    // Await will-navigate event observation
    await waitForCondition(() => willNavigateObserved, 4000, 50, 'Chromium did not emit will-navigate event on location assignment');
    await waitForCondition(() => willNavigateDefaultPrevented, 2000, 50, 'will-navigate listener did not call preventDefault()');

    const currentUrl = qcWin.webContents.getURL();
    if (currentUrl.includes('example.com') || !currentUrl.includes('#quick-chat')) {
      throw new Error(`Renderer-initiated navigation was NOT denied! Navigated to: ${currentUrl}`);
    }
    this.log('Verified: will-navigate event fired, preventDefault was asserted, and URL remained trusted');

    // 4. Real renderer-initiated window.open
    const windowsBefore = BrowserWindow.getAllWindows().length;
    await cdp.evaluate(`
      (() => {
        try { window.open('https://example.com/popup', '_blank'); } catch (e) {}
      })()
    `);
    await sleep(400);
    const windowsAfter = BrowserWindow.getAllWindows().length;

    if (windowsAfter > windowsBefore) {
      throw new Error('window.open was NOT denied! New window was created');
    }
    this.log('Verified: setWindowOpenHandler denied popup window creation');

    this.results.scenarios.sandboxAndNavigationDeny = {
      status: 'PASS',
      webPreferencesInspector: 'webContents.getLastWebPreferences()',
      webPreferencesObservation: {
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
      },
      sandbox: sandboxOk,
      contextIsolation: contextIsolationOk,
      nodeIntegration: prefs.nodeIntegration,
      kernelSandboxAssessment: 'NOT_ASSESSED',
      rendererGlobalsIsolated: true,
      willNavigateDefaultPrevented: true,
      windowOpenDenied: true,
    };
  }

  /**
   * Scenario 8: Quit Lifecycle & Native Unsaved-Editor Guard
   */
  async scenario8_QuitLifecycleAndUnsavedEditorGuard() {
    this.log('--- Scenario 8: Quit Lifecycle & Native Unsaved-Editor Guard ---');
    const qcWin = this.ctx.getQuickChatWindow();
    const mainWin = this.ctx.getMainWindow();

    if (!qcWin || !mainWin) {
      throw new Error('Both Quick Chat and Main windows required for quit lifecycle test');
    }

    // 1. Popup close hides without destroying
    this.log('Testing popup close lifecycle (close() hides window)...');
    qcWin.close();
    await sleep(200);

    if (qcWin.isDestroyed() || qcWin.isVisible()) {
      throw new Error('Popup close() did not hide or improperly destroyed window during active app session');
    }
    this.log('Verified: Calling close() on Quick Chat hid the window without destroying it!');

    // A newly created popup may finish loading after the user already closed it.
    // Recreate the test instance, close it during initial navigation, and verify
    // that no readiness fallback can reopen it afterward.
    this.log('Verifying a popup closed before first load never reopens...');
    qcWin.destroy();
    this.ctx.armCloseQuickChatBeforeFirstLoad();
    const diagnosticStart = this.ctx.getWindowDiagnostics().length;
    this.ctx.toggleQuickChat();
    await waitForCondition(() => {
      const current = this.ctx.getQuickChatWindow();
      const events = this.ctx.getWindowDiagnostics().slice(diagnosticStart);
      return current && !current.isDestroyed() && !current.isVisible() &&
        events.some((entry) => entry.tag === 'did-finish-load');
    }, 5000, 50, 'Quick Chat early-close regression did not finish loading');
    await sleep(200);
    const closedEarlyWindow = this.ctx.getQuickChatWindow();
    const earlyCloseEvents = this.ctx.getWindowDiagnostics().slice(diagnosticStart);
    if (!closedEarlyWindow || closedEarlyWindow.isDestroyed() || closedEarlyWindow.isVisible() ||
        earlyCloseEvents.some((entry) => entry.tag === 'show')) {
      throw new Error('Quick Chat reopened after being closed before first load');
    }
    this.log('Verified: closing before first load kept the loaded popup hidden!');

    // 2. Native Unsaved-Editor Guard
    if (this.results.platform.isWayland) {
      this.log('Notice: Wayland headless environment cannot drive native modal dialogs without user session.');
      this.results.scenarios.quitLifecycle = {
        status: 'UNSUPPORTED',
        reason: 'Wayland headless environment cannot drive native modal dialogs via virtual input; unsaved-editor discard prompt requires native interactive session',
        popupCloseHidNotDestroyed: true,
        earlyCloseBeforeLoadStayedHidden: true,
      };
      return;
    }

    // Set dirty state using the REAL preload API in mainWindow (passes assertTrustedSender)
    this.log('Setting editor dirty via real mainWindow preload IPC (window.piDesktop.ui.setEditorDirty)...');
    const mainCdp = new CdpHelper(mainWin.webContents);
    await mainCdp.attach();

    await mainCdp.evaluate(`
      (() => {
        if (window.piDesktop && window.piDesktop.ui && window.piDesktop.ui.setEditorDirty) {
          window.piDesktop.ui.setEditorDirty(true, 'validation-scratch.ts');
          return true;
        }
        return false;
      })()
    `);
    await sleep(300);

    // Track before-quit interception
    let quitPrevented = false;
    const beforeQuitHandler = (e) => {
      setImmediate(() => {
        quitPrevented = e.defaultPrevented;
      });
    };
    app.once('before-quit', beforeQuitHandler);

    this.log('Triggering app.quit() with dirty editor buffer...');
    const dialogCountBeforeQuit = this.ctx.getNativeDialogs().length;
    app.quit();

    // Await before-quit and assert defaultPrevented
    await waitForCondition(() => quitPrevented, 5000, 50, 'before-quit was not prevented by editor guard');
    this.log('Verified: before-quit preventDefault() was asserted by editor guard!');

    // Dismiss real native dialog via native OS Escape injection
    this.log(`Native dialogs before dismissal: ${JSON.stringify(this.ctx.getNativeDialogs())}`);
    this.log(`Main window before dismissal: visible=${mainWin.isVisible()} focused=${mainWin.isFocused()}`);
    mainWin.show();
    if (process.platform === 'darwin') {
      mainWin.focus();
      await waitForCondition(() => app.isActive(), 3000, 50, 'Application did not become active for native dialog dismissal');
    } else if (process.platform === 'win32') {
      await waitForCondition(() => inspectNativeWindowsModal(process.pid, 'Unsaved changes').success,
        8000, 100, 'Native Windows discard dialog was not visible and activatable');
    } else {
      await waitForCondition(() => this.ctx.getNativeDialogs().length > dialogCountBeforeQuit,
        3000, 50, 'Native discard dialog was not created before Escape');
    }
    this.log('Dismissing real native discard dialog via native OS Escape...');
    const escapeRes = await injectNativeEscape();
    if (!escapeRes.success) {
      throw new Error(`Failed to inject native Escape key to dismiss dialog: ${escapeRes.error}`);
    }
    await waitForCondition(() => this.ctx.getNativeDialogs().some(
      (entry, index) => index >= dialogCountBeforeQuit && entry.settled
    ), 5000, 50, 'Native discard dialog did not settle after Escape');
    const nativeDialog = this.ctx.getNativeDialogs()[dialogCountBeforeQuit];
    if (!nativeDialog || nativeDialog.response !== 1) {
      throw new Error(`Native discard dialog did not choose Keep editing: ${JSON.stringify(nativeDialog)}`);
    }

    // Verify main and the current popup remain alive after modal dismissal.
    // qcWin is the deliberately destroyed instance from the early-close setup.
    if (mainWin.isDestroyed() || closedEarlyWindow.isDestroyed()) {
      throw new Error('Windows were destroyed after dismissing modal discard prompt!');
    }
    this.log('Verified: Main and Quick Chat windows remained alive after modal dismissal!');

    // Clear dirty state via real preload API
    await mainCdp.evaluate(`
      (() => {
        if (window.piDesktop && window.piDesktop.ui && window.piDesktop.ui.setEditorDirty) {
          window.piDesktop.ui.setEditorDirty(false, null);
        }
      })()
    `);
    await sleep(200);

    this.results.scenarios.quitLifecycle = {
      status: 'PASS',
      popupCloseHidNotDestroyed: true,
      earlyCloseBeforeLoadStayedHidden: true,
      editorGuardPreventedQuit: true,
      modalDismissedViaNativeEscape: true,
      windowsPreserved: true,
    };
  }
}

module.exports = {
  ValidationRunner,
};
