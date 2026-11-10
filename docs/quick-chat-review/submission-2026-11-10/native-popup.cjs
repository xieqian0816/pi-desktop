
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const root = process.env.PROBE_ROOT;
const repo = process.env.PROBE_REPO;
app.setPath('home', process.env.HOME);
app.setPath('userData', process.env.PI_DESKTOP_USER_DATA_DIR);
app.setAppPath(repo);
const steps = [];
const mark = (name, detail) => { steps.push({name, detail}); console.log('PROBE', name, detail ?? ''); };
const check = (value, message) => { if (!value) throw new Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 35000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) { let value; try { value = await fn(); } catch {} if (value) return value; await pause(70); }
 throw new Error('Timed out: ' + label);
}
const js = (win, source) => win.webContents.executeJavaScript(source, true);
const text = win => js(win, 'document.body.innerText');
async function fill(win, value) {
 await js(win, `(() => {const el=document.querySelector('textarea'); if(!el) throw Error('No composer'); el.focus(); el.value=${JSON.stringify(value)}; el.setSelectionRange(el.value.length,el.value.length); el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await pause(100);
}
async function click(win, selector, contains) {
 return js(win, `(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${contains ? `el.textContent.includes(${JSON.stringify(contains)})` : 'true'}); if(!el) throw Error('Missing element: '+${JSON.stringify(selector+' '+(contains||''))}); el.click();return true;})()`);
}
async function enter(win) {
 win.focus(); win.webContents.focus();
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
 win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
}
app.on('browser-window-created', (_event, window) => {
 window.webContents.on('render-process-gone', (_event, detail) => console.error('RENDERER_GONE', detail.reason));
 window.webContents.on('preload-error', (_event, _path, error) => console.error('PRELOAD_ERROR', error.message));
});
app.whenReady().then(() => {
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (details, callback) =>
  callback({cancel:!details.url.startsWith('http://127.0.0.1:')}));
 setTimeout(run, 200);
});
require(path.join(repo, 'out/main/index.js'));
async function run() {
 let main, popup;
 try {
  main = await until(() => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#quick-chat') && !w.webContents.isLoading()), 'main renderer');
  await until(() => js(main, '!!window.piDesktop && !!document.querySelector("main,button")'), 'main preload');
  const workspace = await js(main, `window.piDesktop.workspace.create('Smoke project', ${JSON.stringify(path.join(root,'project'))})`);
  // Exercise the actual Ctrl/Cmd+K entry, not the settings IPC shortcut.
  main.show(); main.focus(); main.webContents.focus();
  main.webContents.sendInputEvent({type:'keyDown', keyCode:'K', modifiers:[process.platform==='darwin'?'meta':'control']});
  main.webContents.sendInputEvent({type:'keyUp', keyCode:'K', modifiers:[process.platform==='darwin'?'meta':'control']});
  await until(async () => (await text(main)).includes('Quick Chat'), 'Quick Chat command in switcher');
  await click(main, 'button', 'Quick Chat');
  popup = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('#quick-chat') && !w.webContents.isLoading()), 'popup');
  await until(() => js(popup, '!!document.querySelector("textarea")'), 'shared composer');
  const initial = await js(popup, 'window.piQuickChat.getContext()');
  check(initial.binding === null, 'Opening the popup must not bind a runtime');
  check(initial.runtimes.every(r => !r.pid), 'Opening the popup must not spawn an agent');
  check((await text(popup)).includes('No project'), 'The initial draft must be unassigned');
  await js(popup, `window.probeEvents=[];window.piQuickChat.onUpdate(u=>{if(u.type==='event' && ['message_start','message_end','turn_end','agent_end'].includes(u.event.type))window.probeEvents.push(u.event)});true`);
  mark('palette entry and unassigned draft');
  check(initial.canPin && popup.isAlwaysOnTop(),'macOS popup must support native always-on-top');
  await click(popup,'button[aria-label^="Pin on top"]');
  await until(async () => (await js(popup,'window.piQuickChat.getContext()')).pinned,'pin confirmation');
  main.focus(); main.webContents.focus(); await pause(250);
  check(popup.isVisible(),'Pinned popup must survive main focus');
  popup.focus(); popup.webContents.focus();
  await click(popup,'button[aria-pressed="true"]');
  await until(async () => !(await js(popup,'window.piQuickChat.getContext()')).pinned,'unpin confirmation');
  main.focus(); main.webContents.focus();
  await until(() => !popup.isVisible(),'unpinned popup hides after main focus');
  await js(main,'window.piDesktop.settings.openQuickChat()');
  await until(() => popup.isVisible(),'reshow after blur');
  mark('native macOS pin and blur behavior');
  await click(popup, 'button', 'No project');
  await click(popup, '[role="option"]', 'Smoke project');
  await fill(popup, '@fix');
  await until(async () => (await text(popup)).includes('fixture.txt'), 'file mention results');
  await click(popup, 'button', 'fixture.txt');
  check((await js(popup, 'document.querySelector("textarea").value')).includes('@'), 'Mention insertion missing');
  mark('shared file mention');
  await fill(popup, '/mo');
  await until(async () => (await text(popup)).includes('/model'), 'slash command completion');
  mark('shared slash command');
  await fill(popup, '');
  await click(popup, 'button[aria-label="Select model"]');
  await until(async () => js(popup, '!!document.querySelector("[data-model-index]")'), 'real engine model catalog');
  check((await text(popup)).includes('Local Probe'), 'Local model must appear in the real catalog');
  await click(popup, '[data-model-index]');
  mark('real engine catalog and shared picker');
  await fill(popup, 'PLAIN_PROBE'); await enter(popup);
  await until(async () => (await text(popup)).includes('LOCAL_REPLY_OK'), 'real streamed answer');
  let context = await js(popup, 'window.piQuickChat.getContext()');
  const binding = context.binding;
  check(binding && binding.runtime.engine === process.env.PROBE_ENGINE, 'Runtime must use the configured engine');
  await until(async () => {const s=await js(popup, `window.piQuickChat.getSnapshot(${binding.version})`); return s.messages.length>=2 && s.streaming===null;}, 'settled answer');
  mark('real engine streamed reply', {engine:binding.runtime.engine,pid:binding.runtime.pid});
  await fill(popup, '');
  popup.webContents.sendInputEvent({type:'keyDown',keyCode:'Up'});
  popup.webContents.sendInputEvent({type:'keyUp',keyCode:'Up'});
  await until(async () => (await js(popup, 'document.querySelector("textarea").value')) === 'PLAIN_PROBE', 'prompt recall');
  mark('shared prompt recall');
  const beforeOpen = await js(main,'window.piDesktop.session.listRuntimes()');
  check(beforeOpen.find(r=>r.runtimeId===binding.runtime.runtimeId)?.active===false, 'Popup must not change main selection');
  fs.writeFileSync(path.join(root,'popup-reply.png'),(await popup.webContents.capturePage()).toPNG());
  await fill(popup, 'APPROVAL_PROBE'); await enter(popup);
  const background = await js(main, `window.piDesktop.session.launchTask({workspaceId:${JSON.stringify(workspace.id)},prompt:'BACKGROUND_PROBE'})`);
  const liveBackground = await until(async () => (await js(main, 'window.piDesktop.session.listRuntimes()')).find(r=>r.runtimeId===background.runtimeId && r.pid && r.activity==='working'), 'independent background runtime');
  const approval = await until(async () => {const s=await js(popup, `window.piQuickChat.getSnapshot(${binding.version})`);return s.request;}, 'real permission request');
  mark('real permission request', {method:approval.method});
  const approvalText = await text(popup);
  check((approvalText.match(/Write file/g)||[]).length===1 && !approvalText.includes('Created smoke.txt'),'The pending tool must have exactly one live card');
  mark('single live tool card during approval');
  fs.writeFileSync(path.join(root,'approval-snapshot.json'),JSON.stringify(await js(popup,`(async()=>window.piQuickChat.getSnapshot((await window.piQuickChat.getContext()).binding.version))()`),null,2));
  fs.writeFileSync(path.join(root,'rendered-messages.json'),JSON.stringify(await js(popup,`(() => {const result=new Map();for(const el of document.querySelectorAll('*')){const key=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));let f=el[key];while(f){const m=f.memoizedProps?.message;if(m?.role)result.set(m.id,m);f=f.return}}return [...result.values()]})()`),null,2));
  fs.writeFileSync(path.join(root,'popup-approval.png'),(await popup.webContents.capturePage()).toPNG());
  // Open hands off the pending approval along with the exact runtime.
  await click(popup, 'button[aria-label="Open"]');
  await until(async () => (await js(main, 'window.piDesktop.session.listRuntimes()')).some(r=>r.runtimeId===binding.runtime.runtimeId && r.active), 'exact runtime handoff');
  await until(async () => (await text(main)).includes('smoke.txt'), 'approval replay in main');
  const buttons = await js(main, '[...document.querySelectorAll("button")].map(b=>b.textContent.trim()).filter(Boolean)');
  const allow = buttons.find(b => b==='Allow once' || b==='Allow' || b==='Yes' || b==='Confirm');
  check(allow, 'Missing approval accept button: '+JSON.stringify(buttons));
  await click(main, 'button', allow);
  await until(() => fs.existsSync(path.join(root,'project','smoke.txt')), 'approved write');
  check(fs.readFileSync(path.join(root,'project','smoke.txt'),'utf8')==='LOCAL_TOOL_OK', 'Approved tool wrote unexpected content');
  await until(async () => (await text(main)).includes('APPROVAL_DONE'), 'answer following approval');
  mark('pending approval handoff and real tool completion');
  fs.writeFileSync(path.join(root,'events.json'),JSON.stringify(await js(popup,'window.probeEvents'),null,2));
  const runtimes = await js(main, 'window.piDesktop.session.listRuntimes()');
  const bound = runtimes.find(r=>r.runtimeId===binding.runtime.runtimeId);
  check(bound && bound.pid===binding.runtime.pid, 'Handoff must keep the same engine process');
  const sessionPath = bound.sessionPath;
  check(sessionPath && fs.readFileSync(sessionPath,'utf8').includes('LOCAL_REPLY_OK'), 'Session must persist the real response');
  mark('same-process handoff and persisted history');
  const other = (await js(main, 'window.piDesktop.session.listRuntimes()')).find(r=>r.runtimeId===background.runtimeId);
  check(other && other.pid===liveBackground.pid && other.activity==='working', 'Handoff must preserve the independent running process');
  await until(async () => (await js(main, 'window.piDesktop.session.listRuntimes()')).some(r=>r.runtimeId===background.runtimeId && r.activity==='completed'), 'background task completes after handoff');
  const finalOther = (await js(main, 'window.piDesktop.session.listRuntimes()')).find(r=>r.runtimeId===background.runtimeId);
  check(finalOther.pid===liveBackground.pid && fs.readFileSync(finalOther.sessionPath,'utf8').includes('BACKGROUND_DONE'), 'Background process must finish and persist its response');
  mark('independent background process survived and completed');
  // With no speech model installed, the shared microphone must open Settings.
  await js(main,'window.piDesktop.settings.openQuickChat()');
  await until(() => popup.isVisible(), 'reshow popup');
  await until(() => js(popup, `!!document.querySelector('button[aria-label^="Set up voice dictation"]:not(:disabled)')`), 'enabled microphone');
  await click(popup,'button[aria-label^="Set up voice dictation"]');
  await until(async () => (await text(main)).includes('Voice dictation'), 'voice setup in main settings');
  mark('shared microphone setup entry');
  await js(main,'window.piDesktop.settings.openQuickChat()');
  await until(()=>popup.isVisible(),'reshow settled history');
  await until(async()=> (await text(popup)).includes('APPROVAL_DONE'),'settled popup history');
  const settledText=await text(popup);
  check((settledText.match(/Created smoke.txt/g)||[]).length===1,'The settled tool must have exactly one transcript card');
  mark('single settled tool card after history reload');
  fs.writeFileSync(path.join(root,'popup-settled.png'),(await popup.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(root,'final-snapshot.json'),JSON.stringify(await js(popup,`(async()=>window.piQuickChat.getSnapshot((await window.piQuickChat.getContext()).binding.version))()`),null,2));
  fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({engine:process.env.PROBE_ENGINE,steps},null,2));
  // Normal lifecycle stops only the probe's engines.
  app.quit();
 } catch (error) {
  console.error('PROBE_FAILED', error.stack);
  if (popup && !popup.isDestroyed()) fs.writeFileSync(path.join(root,'popup.txt'),await text(popup).catch(String));
  if (main && !main.isDestroyed()) fs.writeFileSync(path.join(root,'main.txt'),await text(main).catch(String));
  fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({engine:process.env.PROBE_ENGINE,steps,error:String(error)},null,2));
  process.exitCode=1; app.quit();
 }
}
