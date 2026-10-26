/**
 * Chrome DevTools Protocol (CDP) and DOM helper for Electron webContents.
 *
 * Uses Electron's built-in `webContents.debugger` for reliable, non-mocked DOM
 * inspection and manipulation, avoiding synthetic IPC or shortcut callbacks.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class CdpHelper {
  constructor(webContents) {
    this.webContents = webContents;
    this.attached = false;
  }

  async attach() {
    if (this.attached || this.webContents.isDestroyed()) return;
    try {
      this.webContents.debugger.attach('1.3');
      this.attached = true;
      this.webContents.debugger.on('detach', () => {
        this.attached = false;
      });
      await this.sendCommand('Runtime.enable');
      await this.sendCommand('DOM.enable');
      await this.sendCommand('Page.enable');
    } catch (err) {
      if (err.message && err.message.includes('already attached')) {
        this.attached = true;
      } else {
        throw err;
      }
    }
  }

  async detach() {
    if (!this.attached || this.webContents.isDestroyed()) return;
    try {
      this.webContents.debugger.detach();
    } catch {
      // Ignore
    } finally {
      this.attached = false;
    }
  }

  async sendCommand(method, params = {}) {
    if (!this.attached) await this.attach();
    return this.webContents.debugger.sendCommand(method, params);
  }

  /**
   * Evaluates a JavaScript expression in the renderer page.
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const res = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${desc}`);
    }
    return res.result ? res.result.value : undefined;
  }

  /**
   * Checks if an element matching selector exists in DOM.
   * @param {string} selector
   * @returns {Promise<boolean>}
   */
  async elementExists(selector) {
    const res = await this.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    return Boolean(res);
  }

  /**
   * Waits for an element matching selector to appear. Throws fail-closed on timeout.
   * @param {string} selector
   * @param {number} [timeoutMs=8000]
   * @returns {Promise<boolean>}
   */
  async waitForSelector(selector, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.elementExists(selector)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for selector: "${selector}" (exceeded ${timeoutMs}ms)`);
  }

  /**
   * Waits for an element matching selector to be removed from DOM. Throws fail-closed on timeout.
   * @param {string} selector
   * @param {number} [timeoutMs=8000]
   * @returns {Promise<boolean>}
   */
  async waitForSelectorRemoved(selector, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!(await this.elementExists(selector))) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for selector removal: "${selector}" (exceeded ${timeoutMs}ms)`);
  }

  /**
   * Focuses an element and inserts text using genuine CDP Input.insertText events,
   * driving real React synthetic input handling.
   * @param {string} selector
   * @param {string} text
   * @returns {Promise<string>}
   */
  async typeInElement(selector, text) {
    // 1. Focus element and select existing text
    await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Element not found to focus: " + ${JSON.stringify(selector)});
        el.focus();
        if (typeof el.select === 'function') el.select();
        return true;
      })()
    `);

    // 2. Dispatch genuine text insertion via CDP Input domain
    await this.sendCommand('Input.insertText', { text });

    // 3. Return current element value
    return this.getElementValue(selector);
  }

  /**
   * Dispatches an Escape key event via CDP Input domain.
   */
  async dispatchEscapeKey() {
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
      key: 'Escape',
      code: 'Escape',
    });
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
      key: 'Escape',
      code: 'Escape',
    });
  }

  /**
   * Clicks an element in the DOM.
   * @param {string} selector
   * @returns {Promise<boolean>}
   */
  async clickElement(selector) {
    const code = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Element not found to click: " + ${JSON.stringify(selector)});
        el.click();
        return true;
      })()
    `;
    return this.evaluate(code);
  }

  /**
   * Gets the value or text of an element.
   * @param {string} selector
   * @returns {Promise<string|null>}
   */
  async getElementValue(selector) {
    const code = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return el.value !== undefined ? el.value : el.textContent;
      })()
    `;
    return this.evaluate(code);
  }

  /**
   * Inspects bounding client rect of an element.
   * @param {string} selector
   * @returns {Promise<{ left: number, top: number, right: number, bottom: number, width: number, height: number } | null>}
   */
  async getElementRect(selector) {
    const code = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      })()
    `;
    return this.evaluate(code);
  }

  /**
   * Tests whether two DOM elements overlap visually and verifies positive viewport geometry.
   * @param {string} selectorA
   * @param {string} selectorB
   * @returns {Promise<{ rectA: object, rectB: object, overlap: boolean, positiveArea: boolean, inViewport: boolean } | null>}
   */
  async checkElementOverlap(selectorA, selectorB) {
    const code = `
      (() => {
        const a = document.querySelector(${JSON.stringify(selectorA)});
        const b = document.querySelector(${JSON.stringify(selectorB)});
        if (!a || !b) return null;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();

        const aPositive = ra.width > 0 && ra.height > 0;
        const bPositive = rb.width > 0 && rb.height > 0;
        const aInViewport = ra.top >= 0 && ra.left >= 0 &&
          ra.right <= window.innerWidth && ra.bottom <= window.innerHeight;
        const bInViewport = rb.top >= 0 && rb.left >= 0 &&
          rb.right <= window.innerWidth && rb.bottom <= window.innerHeight;

        const overlap = !(ra.right <= rb.left || ra.left >= rb.right || ra.bottom <= rb.top || ra.top >= rb.bottom);
        return {
          rectA: { left: ra.left, top: ra.top, right: ra.right, bottom: ra.bottom, width: ra.width, height: ra.height },
          rectB: { left: rb.left, top: rb.top, right: rb.right, bottom: rb.bottom, width: rb.width, height: rb.height },
          overlap,
          positiveArea: aPositive && bPositive,
          inViewport: aInViewport && bInViewport,
        };
      })()
    `;
    return this.evaluate(code);
  }
}

/**
 * Captures a screenshot of an Electron window.
 * Saves directly to PNG using Electron's native surface capture without desktop exposure.
 * @param {Electron.BrowserWindow} win
 * @param {string} outPath
 * @returns {Promise<{ path: string, width: number, height: number }>}
 */
async function captureWindowScreenshot(win, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const image = await win.capturePage();
  const pngBuffer = image.toPNG();
  fs.writeFileSync(outPath, pngBuffer);
  const size = image.getSize();

  if (process.platform === 'darwin' && typeof win.getMediaSourceId === 'function') {
    try {
      const match = win.getMediaSourceId().match(/:(\d+)$/);
      if (match) {
        const windowId = match[1];
        const nativePath = outPath.replace(/\.png$/, '-native.png');
        spawnSync('screencapture', ['-l', windowId, '-x', nativePath], { timeout: 3000 });
      }
    } catch {
      // Optional best-effort
    }
  }

  return { path: outPath, width: size.width, height: size.height };
}

module.exports = {
  CdpHelper,
  captureWindowScreenshot,
};
