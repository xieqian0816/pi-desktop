#!/usr/bin/env node
/**
 * Deterministic Test Suite for Acceptance Report Validator.
 *
 * Exercises all positive and negative report validation cases via child process execution:
 * - missing argument (--report)
 * - missing report file
 * - malformed JSON report
 * - overallStatus FAIL
 * - overallStatus ERROR
 * - overallStatus PENDING
 * - scenario failure under overall PASS
 * - false or missing minimum-size, viewport, or runtime security evidence
 * - missing scenario (less than 8 required)
 * - unknown extra scenario name
 * - unapproved PARTIAL limitation on Wayland (e.g. menuHandlerToggle UNSUPPORTED)
 * - PARTIAL on non-Wayland platform (e.g. X11 or Windows)
 * - missing Wayland portal evidence on shortcutOpenHideReopen
 * - platform mismatch
 * - displayServer mismatch
 * - valid full PASS (all 8 scenarios PASS)
 * - valid Wayland PARTIAL (five PASS, three evidenced capability limitations)
 * - copied fixture: known Linux X11 failure report
 * - copied fixture: known Linux Wayland failure report
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const assert = require('assert');

const validatorScript = path.join(__dirname, 'validate-report.cjs');
const fixturesDir = path.join(__dirname, 'fixtures');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-validator-test-'));

function runValidator(args = []) {
  return spawnSync(process.execPath, [validatorScript, ...args], {
    encoding: 'utf8',
  });
}

function writeTempReport(filename, data) {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}

function createFullPassScenarios() {
  return {
    shortcutOpenHideReopen: { status: 'PASS' },
    menuHandlerToggle: { status: 'PASS' },
    settingsQuickChatButton: { status: 'PASS' },
    pinVsBlur: { status: 'PASS' },
    displayAwareBounds: { status: 'PASS', minConstraintsRespected: true },
    draftVisibleDuringModelSelectionNoResize: {
      status: 'PASS',
      positiveGeometry: true,
      inViewport: true,
      noVisualOverlap: true,
    },
    sandboxAndNavigationDeny: {
      status: 'PASS',
      webPreferencesInspector: 'webContents.getLastWebPreferences()',
      webPreferencesObservation: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      kernelSandboxAssessment: 'NOT_ASSESSED',
      rendererGlobalsIsolated: true,
      willNavigateDefaultPrevented: true,
      windowOpenDenied: true,
    },
    quitLifecycle: { status: 'PASS' },
  };
}

function createValidWaylandPartialScenarios() {
  return {
    ...createFullPassScenarios(),
    shortcutOpenHideReopen: {
      status: 'UNSUPPORTED',
      reason: 'Compositor does not support the virtual keyboard protocol',
      actualPortalIntrospection: {
        isWayland: true,
        hasGlobalShortcutsInterface: false,
        reason: 'org.freedesktop.portal.GlobalShortcuts interface NOT found in /org/freedesktop/portal/desktop',
      },
    },
    menuHandlerToggle: { status: 'PASS' },
    settingsQuickChatButton: { status: 'PASS' },
    pinVsBlur: {
      status: 'UNSUPPORTED',
      reason: 'Native Wayland compositor did not grant keyboard focus or emit a focus-to-blur transition',
      nativeFocusEvidence: {
        initialFocused: false,
        focusedAfterFocusRequest: false,
        blurObserved: false,
        focusedAfterBlurRequest: false,
        focusedWindow: null,
      },
    },
    quitLifecycle: {
      status: 'UNSUPPORTED',
      reason: 'Headless Weston compositor cannot drive native modal dialogs without user session',
    },
  };
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// 1. Missing CLI argument (--report not provided)
test('negative: missing --report argument returns nonzero', () => {
  const res = runValidator([]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 2. Missing report file
test('negative: missing report file returns nonzero', () => {
  const missingPath = path.join(tmpDir, 'non-existent-report.json');
  const res = runValidator([`--report=${missingPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 3. Malformed JSON
test('negative: malformed JSON returns nonzero', () => {
  const badJsonPath = writeTempReport('malformed.json', '{ "overallStatus": "PASS", invalid-json }');
  const res = runValidator([`--report=${badJsonPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 4. overallStatus: FAIL
test('negative: overallStatus FAIL returns nonzero', () => {
  const reportPath = writeTempReport('fail.json', {
    overallStatus: 'FAIL',
    error: 'HotKey #2 injection failed',
    platform: { os: 'linux', displayServer: 'x11' },
    scenarios: createFullPassScenarios(),
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 5. overallStatus: ERROR
test('negative: overallStatus ERROR returns nonzero', () => {
  const reportPath = writeTempReport('error.json', {
    overallStatus: 'ERROR',
    error: 'Fatal runner exception',
    platform: { os: 'linux', displayServer: 'x11' },
    scenarios: createFullPassScenarios(),
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 6. overallStatus: PENDING
test('negative: overallStatus PENDING returns nonzero', () => {
  const reportPath = writeTempReport('pending.json', {
    overallStatus: 'PENDING',
    platform: { os: 'win32', displayServer: 'windows' },
    scenarios: createFullPassScenarios(),
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 7. Scenario failure under overall PASS
test('negative: scenario failure under overall PASS returns nonzero', () => {
  const scenarios = createFullPassScenarios();
  scenarios.pinVsBlur = { status: 'FAIL', reason: 'Focus lost' };
  const reportPath = writeTempReport('fabricated-pass.json', {
    overallStatus: 'PASS',
    platform: { os: 'win32', displayServer: 'windows' },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

test('negative: contradictory minimum-dimension evidence cannot PASS', () => {
  const scenarios = createFullPassScenarios();
  scenarios.displayAwareBounds.minConstraintsRespected = false;
  const reportPath = writeTempReport('false-minimum-constraints.json', {
    overallStatus: 'PASS',
    platform: { os: 'win32', displayServer: 'windows' },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

test('negative: missing minimum-dimension evidence cannot PASS', () => {
  const scenarios = createFullPassScenarios();
  delete scenarios.displayAwareBounds.minConstraintsRespected;
  const reportPath = writeTempReport('missing-minimum-constraints.json', {
    overallStatus: 'PASS',
    platform: { os: 'linux', displayServer: 'x11' },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

test('negative: out-of-viewport geometry evidence cannot PASS', () => {
  const scenarios = createFullPassScenarios();
  scenarios.draftVisibleDuringModelSelectionNoResize.inViewport = false;
  const reportPath = writeTempReport('false-viewport-evidence.json', {
    overallStatus: 'PASS',
    platform: { os: 'linux', displayServer: 'x11' },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

test('negative: missing runtime security observation cannot PASS', () => {
  const scenarios = createFullPassScenarios();
  delete scenarios.sandboxAndNavigationDeny.webPreferencesObservation;
  const reportPath = writeTempReport('missing-security-observation.json', {
    overallStatus: 'PASS',
    platform: { os: 'linux', displayServer: 'x11' },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

test('negative: observed insecure runtime webPreferences cannot PASS', () => {
  const scenarios = createFullPassScenarios();
  scenarios.sandboxAndNavigationDeny.webPreferencesObservation.sandbox = false;
  const reportPath = writeTempReport('false-security-observation.json', {
    overallStatus: 'PASS',
    platform: { os: 'win32', displayServer: 'windows' },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 8. Missing required scenario (only 7 scenarios)
test('negative: missing required scenario returns nonzero', () => {
  const scenarios = createFullPassScenarios();
  delete scenarios.quitLifecycle;
  const reportPath = writeTempReport('missing-scenario.json', {
    overallStatus: 'PASS',
    platform: { os: 'win32', displayServer: 'windows' },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 9. Unknown extra scenario
test('negative: unknown extra scenario name returns nonzero', () => {
  const scenarios = createFullPassScenarios();
  scenarios.extraRandomTest = { status: 'PASS' };
  const reportPath = writeTempReport('unknown-scenario.json', {
    overallStatus: 'PASS',
    platform: { os: 'win32', displayServer: 'windows' },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 10. Unapproved PARTIAL limitation on Wayland (e.g. menuHandlerToggle UNSUPPORTED)
test('negative: unapproved PARTIAL limitation on Wayland returns nonzero', () => {
  const scenarios = createValidWaylandPartialScenarios();
  scenarios.menuHandlerToggle = { status: 'UNSUPPORTED', reason: 'Menu item missing' };
  const reportPath = writeTempReport('unapproved-limitation.json', {
    overallStatus: 'PARTIAL',
    platform: { os: 'linux', displayServer: 'wayland', isWayland: true },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 11. PARTIAL on non-Wayland platform (e.g. X11)
test('negative: PARTIAL on X11 returns nonzero', () => {
  const scenarios = createValidWaylandPartialScenarios();
  const reportPath = writeTempReport('partial-on-x11.json', {
    overallStatus: 'PARTIAL',
    platform: { os: 'linux', displayServer: 'x11', isWayland: false },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 12. Missing Wayland portal evidence on shortcutOpenHideReopen
test('negative: missing Wayland portal evidence returns nonzero', () => {
  const scenarios = createValidWaylandPartialScenarios();
  delete scenarios.shortcutOpenHideReopen.actualPortalIntrospection;
  const reportPath = writeTempReport('missing-portal-evidence.json', {
    overallStatus: 'PARTIAL',
    platform: { os: 'linux', displayServer: 'wayland', isWayland: true },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 13. Platform mismatch
test('negative: expected platform mismatch returns nonzero', () => {
  const reportPath = writeTempReport('platform-mismatch.json', {
    overallStatus: 'PASS',
    platform: { os: 'linux', displayServer: 'x11' },
    scenarios: createFullPassScenarios(),
  });
  const res = runValidator([`--report=${reportPath}`, '--expected-platform=win32']);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 14. DisplayServer mismatch
test('negative: expected displayServer mismatch returns nonzero', () => {
  const reportPath = writeTempReport('displayserver-mismatch.json', {
    overallStatus: 'PASS',
    platform: { os: 'linux', displayServer: 'x11' },
    scenarios: createFullPassScenarios(),
  });
  const res = runValidator([`--report=${reportPath}`, '--expected-display-server=wayland']);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 15. Valid full PASS (all 8 scenarios PASS)
test('positive: valid full PASS report returns zero', () => {
  const reportPath = writeTempReport('valid-pass.json', {
    overallStatus: 'PASS',
    platform: { os: 'win32', displayServer: 'windows' },
    scenarios: createFullPassScenarios(),
  });
  const res = runValidator([
    `--report=${reportPath}`,
    '--expected-platform=win32',
    '--expected-display-server=windows',
  ]);
  assert.strictEqual(res.status, 0, `Expected exit 0, got ${res.status}. Stderr: ${res.stderr}`);
});

// 16. Valid Wayland PARTIAL (6 PASS, 2 approved limitations with portal evidence)
test('positive: valid Wayland PARTIAL report returns zero', () => {
  const reportPath = writeTempReport('valid-wayland-partial.json', {
    overallStatus: 'PARTIAL',
    platform: { os: 'linux', displayServer: 'wayland', isWayland: true },
    scenarios: createValidWaylandPartialScenarios(),
  });
  const res = runValidator([
    `--report=${reportPath}`,
    '--expected-platform=linux',
    '--expected-display-server=wayland',
  ]);
  assert.strictEqual(res.status, 0, `Expected exit 0, got ${res.status}. Stderr: ${res.stderr}`);
});

test('negative: Wayland pin/blur limitation without native focus evidence returns nonzero', () => {
  const scenarios = createValidWaylandPartialScenarios();
  delete scenarios.pinVsBlur.nativeFocusEvidence;
  const reportPath = writeTempReport('wayland-missing-focus-evidence.json', {
    overallStatus: 'PARTIAL',
    platform: { os: 'linux', displayServer: 'wayland', isWayland: true },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

test('negative: Wayland security scenario cannot be skipped', () => {
  const scenarios = createValidWaylandPartialScenarios();
  scenarios.sandboxAndNavigationDeny = { status: 'UNSUPPORTED', reason: 'Unsupported claim' };
  const reportPath = writeTempReport('wayland-three-limitations.json', {
    overallStatus: 'PARTIAL',
    platform: { os: 'linux', displayServer: 'wayland', isWayland: true },
    scenarios,
  });
  const res = runValidator([`--report=${reportPath}`]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 19. Copied fixture: known Linux X11 failure report
test('fixture: copied Linux X11 failure report returns nonzero', () => {
  const fixturePath = path.join(fixturesDir, 'known-fail-linux-x11.json');
  JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const res = runValidator([
    `--report=${fixturePath}`,
    '--expected-platform=linux',
    '--expected-display-server=x11',
  ]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// 18. Copied fixture: known Linux Wayland failure report
test('fixture: copied Linux Wayland failure report returns nonzero', () => {
  const fixturePath = path.join(fixturesDir, 'known-fail-linux-wayland.json');
  JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const res = runValidator([
    `--report=${fixturePath}`,
    '--expected-platform=linux',
    '--expected-display-server=wayland',
  ]);
  assert.strictEqual(res.status, 1, `Expected exit 1, got ${res.status}`);
});

// Run all tests
let failedCount = 0;
console.log(`Running ${tests.length} acceptance validator tests...\n`);
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedCount++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

// Cleanup temp dir
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}

console.log(`\nResults: ${tests.length - failedCount} passed, ${failedCount} failed.`);
if (failedCount > 0) {
  process.exit(1);
}
