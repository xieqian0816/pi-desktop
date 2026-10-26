#!/usr/bin/env node
/**
 * Independent Acceptance Validator for Pi Desktop Quick Chat Validation Reports.
 *
 * Verifies that the validation report exists, is valid JSON, matches the expected
 * platform/displayServer, and satisfies strict acceptance rules:
 *
 * 1. Required Suite:
 *    Report must contain exactly the 8 required scenarios:
 *    - shortcutOpenHideReopen
 *    - menuHandlerToggle
 *    - settingsQuickChatButton
 *    - pinVsBlur
 *    - displayAwareBounds
 *    - draftVisibleDuringModelSelectionNoResize
 *    - sandboxAndNavigationDeny
 *    - quitLifecycle
 *    Missing scenarios or unknown extra scenario names are strictly rejected.
 *
 * 2. PASS Rules:
 *    - overallStatus must be "PASS".
 *    - All 8 required scenarios must have status "PASS".
 *    - Minimum-size, viewport geometry, and runtime security evidence must be
 *      present and consistent with PASS; false or missing observations fail.
 *    - Any UNSUPPORTED, FAIL, ERROR, PENDING, or unexpected status fails.
 *
 * 3. PARTIAL Rules:
 *    - Allowed ONLY on native Wayland (platform.displayServer === 'wayland' or platform.isWayland === true).
 *    - On Windows, X11, and macOS, UNSUPPORTED is forbidden and PARTIAL fails.
 *    - On Wayland, at least 5 scenarios must be PASS, with at most 3 evidence-backed limitations:
 *      a) shortcutOpenHideReopen (requires honest reason + actualPortalIntrospection evidence)
 *      b) pinVsBlur (requires actual native focus/blur observations from an unprivileged interactive attempt)
 *      c) quitLifecycle (requires honest reason for headless modal dialog limitation)
 *    - Any other scenario marked UNSUPPORTED (e.g. menuHandlerToggle) fails as an unapproved limitation.
 *    - Approved limitations remain visible in acceptance logs.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_SCENARIOS = [
  'shortcutOpenHideReopen',
  'menuHandlerToggle',
  'settingsQuickChatButton',
  'pinVsBlur',
  'displayAwareBounds',
  'draftVisibleDuringModelSelectionNoResize',
  'sandboxAndNavigationDeny',
  'quitLifecycle',
];

const WAYLAND_ALLOWED_UNSUPPORTED = ['shortcutOpenHideReopen', 'pinVsBlur', 'quitLifecycle'];


function validatePassEvidence(name, data, errors) {
  if (name === 'displayAwareBounds' && data.minConstraintsRespected !== true) {
    errors.push(
      'Scenario "displayAwareBounds" cannot be PASS unless minConstraintsRespected === true; false or missing evidence is rejected.'
    );
  }

  if (name === 'draftVisibleDuringModelSelectionNoResize') {
    for (const field of ['positiveGeometry', 'inViewport', 'noVisualOverlap']) {
      if (data[field] !== true) {
        errors.push(`Scenario "${name}" cannot be PASS unless ${field} === true; false or missing evidence is rejected.`);
      }
    }
  }

  if (name === 'sandboxAndNavigationDeny') {
    const preferences = data.webPreferencesObservation;
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences) ||
        preferences.sandbox !== true || preferences.contextIsolation !== true || preferences.nodeIntegration !== false) {
      errors.push('Scenario "sandboxAndNavigationDeny" cannot be PASS without complete, secure runtime webPreferences observations.');
    }
    const expectedEvidence = {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      rendererGlobalsIsolated: true,
      willNavigateDefaultPrevented: true,
      windowOpenDenied: true,
    };
    for (const [field, expected] of Object.entries(expectedEvidence)) {
      if (data[field] !== expected) {
        errors.push(
          `Scenario "sandboxAndNavigationDeny" cannot be PASS unless observed ${field} === ${expected}; contradictory or missing evidence is rejected.`
        );
      }
    }
  }
}

function validateReport(reportData, options = {}) {
  const { expectedPlatform, expectedDisplayServer } = options;
  const errors = [];
  const logs = [];

  if (!reportData || typeof reportData !== 'object' || Array.isArray(reportData)) {
    return {
      valid: false,
      errors: ['Report content is not a valid JSON object.'],
      logs,
    };
  }

  // 1. Verify expected platform/displayServer if specified
  if (expectedPlatform) {
    const actualPlatform = reportData.platform && reportData.platform.os;
    if (actualPlatform !== expectedPlatform) {
      errors.push(`Platform mismatch: expected platform.os="${expectedPlatform}", got "${actualPlatform}"`);
    }
  }

  const actualDisplayServer = (reportData.platform && reportData.platform.displayServer) || '';
  const isWayland =
    actualDisplayServer.toLowerCase() === 'wayland' ||
    Boolean(reportData.platform && reportData.platform.isWayland);

  if (expectedDisplayServer) {
    if (actualDisplayServer !== expectedDisplayServer) {
      errors.push(
        `Display server mismatch: expected platform.displayServer="${expectedDisplayServer}", got "${actualDisplayServer}"`
      );
    }
  }

  // 2. Verify overallStatus: PASS or PARTIAL only
  const overallStatus = reportData.overallStatus;
  const allowedOverall = ['PASS', 'PARTIAL'];
  if (!allowedOverall.includes(overallStatus)) {
    let msg = `overallStatus "${overallStatus}" is not accepted. Must be PASS or PARTIAL.`;
    if (reportData.error) {
      msg += ` Reported error: ${reportData.error}`;
    }
    errors.push(msg);
  }

  // 3. Platform restriction on PARTIAL
  if (overallStatus === 'PARTIAL' && !isWayland) {
    errors.push(
      `overallStatus PARTIAL is not allowed on displayServer "${actualDisplayServer || 'unknown'}". For Windows, Linux X11, and macOS, no UNSUPPORTED is allowed.`
    );
  }

  // 4. Verify scenarios structure and exact scenario names
  const scenarios = reportData.scenarios;
  if (!scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) {
    errors.push('Missing or invalid "scenarios" object in report.');
    return { valid: false, errors, logs };
  }

  const scenarioKeys = Object.keys(scenarios);
  for (const req of REQUIRED_SCENARIOS) {
    if (!scenarioKeys.includes(req)) {
      errors.push(`Missing required scenario "${req}" in report.`);
    }
  }
  for (const key of scenarioKeys) {
    if (!REQUIRED_SCENARIOS.includes(key)) {
      errors.push(`Unknown extra scenario "${key}" in report.`);
    }
  }

  // 5. Verify scenario statuses based on overallStatus and platform
  for (const name of REQUIRED_SCENARIOS) {
    const data = scenarios[name];
    if (!data || typeof data !== 'object') {
      if (scenarioKeys.includes(name)) {
        errors.push(`Scenario "${name}" has missing or invalid payload.`);
      }
      continue;
    }

    const status = data.status;

    if (status === 'PASS') {
      validatePassEvidence(name, data, errors);
    }

    if (overallStatus === 'PASS') {
      if (status !== 'PASS') {
        errors.push(
          `Scenario "${name}" has status "${status}". All eight scenarios must be PASS when overallStatus is PASS.`
        );
      } else {
        logs.push(`Scenario "${name}": PASS`);
      }
    } else if (overallStatus === 'PARTIAL') {
      if (WAYLAND_ALLOWED_UNSUPPORTED.includes(name)) {
        if (status === 'UNSUPPORTED') {
          if (!data.reason || typeof data.reason !== 'string' || data.reason.trim().length === 0) {
            errors.push(`Scenario "${name}" is UNSUPPORTED but lacks an honest reason.`);
          }

          if (name === 'shortcutOpenHideReopen') {
            const portal = data.actualPortalIntrospection;
            if (
              !portal ||
              typeof portal !== 'object' ||
              portal.isWayland !== true ||
              typeof portal.hasGlobalShortcutsInterface !== 'boolean'
            ) {
              errors.push(
                'Scenario "shortcutOpenHideReopen" is UNSUPPORTED on Wayland but lacks valid actualPortalIntrospection evidence.'
              );
            }
          }

          if (name === 'pinVsBlur') {
            const focus = data.nativeFocusEvidence;
            if (
              !focus ||
              typeof focus !== 'object' ||
              typeof focus.initialFocused !== 'boolean' ||
              focus.focusedAfterFocusRequest !== false ||
              focus.focusedAfterBlurRequest !== false ||
              focus.blurObserved !== false ||
              (typeof focus.focusedWindow !== 'number' && focus.focusedWindow !== null)
            ) {
              errors.push(
                'Scenario "pinVsBlur" is UNSUPPORTED on Wayland but lacks native evidence that focus and blur transitions were unavailable.'
              );
            }
          }

          logs.push(
            `Scenario "${name}": UNSUPPORTED (approved Wayland limitation) - reason: ${data.reason || 'unspecified'}`
          );
        } else if (status === 'PASS') {
          logs.push(`Scenario "${name}": PASS`);
        } else {
          errors.push(
            `Scenario "${name}" has forbidden status "${status}" (reason: ${data.reason || data.error || 'none'}).`
          );
        }
      } else {
        // Scenarios other than shortcutOpenHideReopen and quitLifecycle MUST PASS
        if (status === 'UNSUPPORTED') {
          errors.push(
            `Scenario "${name}" has unapproved limitation: status "UNSUPPORTED" is only permitted for ${WAYLAND_ALLOWED_UNSUPPORTED.join(
              ', '
            )} on Wayland.`
          );
        } else if (status !== 'PASS') {
          errors.push(
            `Scenario "${name}" has forbidden status "${status}" (reason: ${data.reason || data.error || 'none'}).`
          );
        } else {
          logs.push(`Scenario "${name}": PASS`);
        }
      }
    }
  }

  // 6. Wayland PARTIAL requires five proven scenarios and at most three supported limitations.
  if (overallStatus === 'PARTIAL' && isWayland) {
    const unsupportedCount = scenarioKeys.filter(
      (k) => scenarios[k] && scenarios[k].status === 'UNSUPPORTED'
    ).length;
    const passCount = scenarioKeys.filter(
      (k) => scenarios[k] && scenarios[k].status === 'PASS'
    ).length;

    if (unsupportedCount > 3 || passCount < 5) {
      errors.push(
        `overallStatus PARTIAL on Wayland requires at least 5 PASS and at most 3 approved UNSUPPORTED scenarios (found ${passCount} PASS, ${unsupportedCount} UNSUPPORTED).`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    logs,
  };
}

function runCLI() {
  const args = process.argv.slice(2);
  const getArg = (prefix) => {
    const match = args.find((a) => a.startsWith(prefix));
    return match ? match.slice(prefix.length) : null;
  };

  const reportPath = getArg('--report=');
  const expectedPlatform = getArg('--expected-platform=');
  const expectedDisplayServer = getArg('--expected-display-server=');

  if (!reportPath) {
    console.error('[ACCEPTANCE ERROR] Missing required argument: --report=<path>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(reportPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`[ACCEPTANCE ERROR] Validation report not found at: ${resolvedPath}`);
    console.error('The validation launcher may have failed, crashed, or terminated before writing the report.');
    process.exit(1);
  }

  let content = '';
  try {
    content = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    console.error(`[ACCEPTANCE ERROR] Failed to read report file at ${resolvedPath}: ${err.message}`);
    process.exit(1);
  }

  let reportJson;
  try {
    reportJson = JSON.parse(content);
  } catch (err) {
    console.error(`[ACCEPTANCE ERROR] Report at ${resolvedPath} is malformed JSON: ${err.message}`);
    process.exit(1);
  }

  const result = validateReport(reportJson, { expectedPlatform, expectedDisplayServer });

  for (const log of result.logs) {
    console.log(`[ACCEPTANCE] ${log}`);
  }

  if (!result.valid) {
    console.error('=================================================================');
    console.error(`[ACCEPTANCE FAILED] Validation report at ${reportPath} REJECTED:`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    console.error('=================================================================');
    process.exit(1);
  }

  console.log('=================================================================');
  console.log(`[ACCEPTANCE PASSED] Report at ${reportPath} ACCEPTED (overallStatus: ${reportJson.overallStatus})`);
  console.log('=================================================================');
  process.exit(0);
}

if (require.main === module) {
  runCLI();
}

module.exports = { validateReport, REQUIRED_SCENARIOS, WAYLAND_ALLOWED_UNSUPPORTED };
