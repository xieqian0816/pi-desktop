const { app, BrowserWindow, dialog, session } = require('electron');
const fs = require('fs');
const path = require('path');
const root = process.env.PROBE_ROOT;
const repo = process.env.PROBE_REPO;
app.setPath('home', process.env.HOME);
app.setPath('userData', process.env.PI_DESKTOP_USER_DATA_DIR);
app.setAppPath(repo);
// The picker is the fixture boundary; opening the project then follows the
// real menu event, preload, IPC and renderer workspace-selection path.
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(root, 'project')] });
const steps = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
async function until(fn, label, timeout = 35000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let value;
    try { value = await fn(); } catch {}
    if (value) return value;
    await pause(70);
  }
  throw new Error('Timed out: ' + label);
}
const js = (win, source) => win.webContents.executeJavaScript(source, true);
const text = win => js(win, 'document.body.innerText');
const requests = () => JSON.parse(fs.readFileSync(path.join(root, 'requests.json'), 'utf8'));
async function fill(win, value) {
  await js(win, `(() => {const el=document.querySelector('textarea'); if(!el) throw Error('No composer'); el.focus(); el.value=${JSON.stringify(value)}; el.setSelectionRange(el.value.length,el.value.length); el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await pause(100);
}
async function clickExact(win, selector, label) {
  await js(win, `(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(label)}); if(!el) throw Error('Missing '+${JSON.stringify(label)}); el.click();})()`);
}
async function enter(win) {
  win.focus(); win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
}
const mark = (name, detail) => {
  check(BrowserWindow.getAllWindows().length === 1, 'Main-only regression must never create Quick Chat');
  steps.push({ name, detail }); console.log('PROBE', name, detail || '');
};
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error' || details.level === 3) console.error('RENDERER_ERROR', details.message);
  });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: !details.url.startsWith('http://127.0.0.1:') }));
  setTimeout(run, 200);
});
require(path.join(repo, 'out/main/index.js'));
async function run() {
  let main;
  try {
    main = await until(() => BrowserWindow.getAllWindows().find(w => !w.webContents.isLoading()), 'main renderer');
    await until(() => js(main, '!!window.piDesktop && !!document.querySelector("button")'), 'main preload');
    await pause(200);
    main.webContents.send('menu:open-project');
    await until(() => js(main, '!!document.querySelector("textarea:not(:disabled)")'), 'selected project composer');
    check(!(await js(main, 'window.piDesktop.session.listRuntimes()')).some(r => r.pid), 'Opening a new project must stay lazy');
    mark('open project through main menu; Quick Chat remains unopened');
    await fill(main, 'MAIN_PLAIN_PROBE'); await enter(main);
    await until(async () => (await text(main)).includes('LOCAL_REPLY_OK'), 'main streamed answer');
    await until(async () => (await js(main, 'window.piDesktop.session.listRuntimes()')).some(r => r.active && r.pid), 'main runtime after sending');
    await until(async () => !(await js(main, 'window.piDesktop.session.getState()')).data?.isStreaming, 'settled main reply');
    const initial = (await js(main, 'window.piDesktop.session.listRuntimes()')).find(r => r.active);
    check(initial.engine === process.env.PROBE_ENGINE, 'Wrong main engine');
    mark('shared composer sends and streams through real engine', { engine: initial.engine, pid: initial.pid });
    await until(() => js(main, '[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Select model" && !b.disabled)'), 'idle main model picker');
    await js(main, '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="Select model").click();true');
    await until(() => js(main, '[...document.querySelectorAll("[data-model-index]")].some(el=>el.textContent.includes("Local Alternate"))'), 'alternate model catalog');
    await js(main, '[...document.querySelectorAll("[data-model-index]")].find(el=>el.textContent.includes("Local Alternate")).click()');
    await until(async () => (await js(main, 'window.piDesktop.session.getState()')).data?.model?.id === 'probe-alt', 'engine model change');
    mark('shared model picker changes actual main runtime model');
    await fill(main, 'MAIN_SLOW_PROBE'); await enter(main);
    await until(async () => (await text(main)).includes('MAIN_SLOW_'), 'delayed main stream');
    await fill(main, 'MAIN_QUEUE_PROBE'); await enter(main);
    await pause(300);
    check(!requests().some(r => r.prompt.includes('MAIN_QUEUE_PROBE')), 'Normal Enter must queue during streaming');
    check(!fs.existsSync(path.join(root, 'release-slow')), 'Slow response was released too early');
    fs.writeFileSync(path.join(root, 'main-queued.png'), (await main.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(root, 'release-slow'), 'release');
    await until(async () => (await text(main)).includes('MAIN_QUEUE_DONE'), 'queued prompt completes');
    const slow = requests().find(r => r.prompt.includes('MAIN_SLOW_PROBE') && !r.prompt.includes('MAIN_QUEUE_PROBE'));
    const queued = requests().find(r => r.prompt.includes('MAIN_QUEUE_PROBE'));
    check(slow.completedAt <= queued.startedAt, 'Queue was sent before first turn ended');
    check(queued.model === 'probe-alt', 'Model choice was not applied to actual request');
    const runtime = (await js(main, 'window.piDesktop.session.listRuntimes()')).find(r => r.active);
    check(runtime.pid === initial.pid && runtime.runtimeId === initial.runtimeId, 'Queue must keep the original main runtime');
    mark('normal Enter queues until completion on same runtime');
    for (const [prompt, file, accept, answer] of [['MAIN_DENY_PROBE', 'denied.txt', false, 'DENIED_DONE'], ['MAIN_ALLOW_PROBE', 'allowed.txt', true, 'ALLOWED_DONE']]) {
      await fill(main, prompt); await enter(main);
      await until(async () => (await text(main)).includes(file), 'permission details for ' + file);
      const labels = await js(main, '[...document.querySelectorAll("button")].map(b=>b.textContent.trim()).filter(Boolean)');
      const label = (accept ? ['Allow once', 'Allow', 'Yes', 'Confirm'] : ['Deny', 'No', 'Cancel']).find(b => labels.includes(b));
      check(label, 'Missing permission answer: ' + JSON.stringify(labels));
      check(!fs.existsSync(path.join(root, 'project', file)), 'Tool ran before approval');
      fs.writeFileSync(path.join(root, accept ? 'main-allow.png' : 'main-deny.png'), (await main.webContents.capturePage()).toPNG());
      await clickExact(main, 'button', label);
      await until(async () => (await text(main)).includes(answer), 'answer after permission');
      check(fs.existsSync(path.join(root, 'project', file)) === accept, 'Permission result did not control file write');
      if (accept) check(fs.readFileSync(path.join(root, 'project', file), 'utf8') === 'LOCAL_TOOL_OK', 'Unexpected write content');
      mark(accept ? 'shared approval allows real tool write' : 'shared approval denies real tool write');
    }
    await fill(main, 'MAIN_UNSENT_DRAFT');
    const before = requests().length;
    await clickExact(main, 'button', 'Settings');
    await until(async () => (await text(main)).includes('Keyboard shortcuts'), 'settings view');
    await clickExact(main, 'button', 'Chat');
    await until(async () => (await js(main, 'document.querySelector("textarea")?.value')) === 'MAIN_UNSENT_DRAFT', 'draft restored after settings');
    check(requests().length === before, 'Navigating with a draft must not send it');
    const final = (await js(main, 'window.piDesktop.session.listRuntimes()')).find(r => r.active);
    check(final.pid === initial.pid, 'Settings navigation restarted the runtime');
    check(!fs.readFileSync(final.sessionPath, 'utf8').includes('MAIN_UNSENT_DRAFT'), 'Unsent draft leaked into session');
    mark('unsent draft survives Settings and Chat navigation');
    fs.writeFileSync(path.join(root, 'main-final.png'), (await main.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ mode: 'main-only', engine: process.env.PROBE_ENGINE, steps }, null, 2));
    app.quit();
  } catch (error) {
    console.error('PROBE_FAILED', error.stack);
    if (main && !main.isDestroyed()) {
      fs.writeFileSync(path.join(root, 'main.txt'), await text(main).catch(String));
      fs.writeFileSync(path.join(root, 'main-failure.png'), (await main.webContents.capturePage()).toPNG());
    }
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ mode: 'main-only', engine: process.env.PROBE_ENGINE, steps, error: String(error) }, null, 2));
    process.exitCode = 1; app.quit();
  }
}
