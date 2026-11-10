const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const repo = process.env.PROBE_REPO || path.join(__dirname, 'feature');
const engine = process.argv[2];
const mode = process.argv[3] || 'popup';
if (!['pi', 'omp'].includes(engine) || !['main', 'popup'].includes(mode)) throw Error('Usage: node run-native.cjs pi|omp main|popup');
const dir = fs.mkdtempSync(path.join(__dirname, engine + '-' + mode + '-'));
const home = path.join(dir, 'home');
const piDir = path.join(home, '.pi', 'agent');
const ompDir = path.join(home, '.omp', 'agent');
const gui = path.join(dir, 'gui');
for (const d of [piDir, ompDir, gui, path.join(dir, 'project')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(dir, 'project', 'fixture.txt'), 'Local mention fixture');
const requests = [];
const record = () => fs.writeFileSync(path.join(dir, 'requests.json'), JSON.stringify(requests, null, 2));
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', b => body += b);
  req.on('end', () => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let json;
    try { json = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
    const messages = json.messages || [];
    const latest = [...messages].reverse().find(x => x.role === 'user');
    const value = typeof latest?.content === 'string' ? latest.content : JSON.stringify(latest?.content || '');
    const toolDone = messages.at(-1)?.role === 'tool';
    const tool = /APPROVAL_PROBE|MAIN_DENY_PROBE|MAIN_ALLOW_PROBE/.test(value) && !toolDone;
    const entry = { url: req.url, model: json.model, prompt: value, tool, startedAt: Date.now() };
    requests.push(entry); record();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'probe-' + requests.length, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: json.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    const end = () => { entry.completedAt = Date.now(); record(); res.end('data: [DONE]\n\n'); };
    chunk({ role: 'assistant', content: '' });
    if (tool) {
      const file = value.includes('MAIN_DENY_PROBE') ? 'denied.txt' : value.includes('MAIN_ALLOW_PROBE') ? 'allowed.txt' : 'smoke.txt';
      chunk({ tool_calls: [{ index: 0, id: 'call_local_' + requests.length, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: file, content: 'LOCAL_TOOL_OK' }) } }] });
      chunk({}, 'tool_calls'); end();
    } else if (value.includes('MAIN_SLOW_PROBE') && !value.includes('MAIN_QUEUE_PROBE')) {
      chunk({ content: 'MAIN_SLOW_' });
      const start = Date.now();
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(dir, 'release-slow')) || Date.now() - start > 25000) {
          clearInterval(timer); chunk({ content: 'DONE' }); chunk({}, 'stop'); end();
        }
      }, 75);
      res.on('close', () => clearInterval(timer));
    } else if (value.includes('BACKGROUND_PROBE')) {
      chunk({ content: 'BACKGROUND_' });
      setTimeout(() => { chunk({ content: 'DONE' }); chunk({}, 'stop'); end(); }, 8000);
    } else {
      const reply = toolDone ? (value.includes('MAIN_DENY_PROBE') ? 'DENIED_DONE' : value.includes('MAIN_ALLOW_PROBE') ? 'ALLOWED_DONE' : 'APPROVAL_DONE') : value.includes('MAIN_QUEUE_PROBE') ? 'MAIN_QUEUE_DONE' : 'LOCAL_REPLY_OK';
      chunk({ content: reply.slice(0, 5) }); chunk({ content: reply.slice(5) }); chunk({}, 'stop'); end();
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const model = (id, name) => ({ id, name, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const config = { providers: { 'local-probe': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-dummy', models: [model('probe', 'Local Probe'), model('probe-alt', 'Local Alternate')] } } };
  fs.writeFileSync(path.join(piDir, 'models.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(ompDir, 'models.yml'), JSON.stringify(config));
  fs.writeFileSync(path.join(gui, 'settings.json'), JSON.stringify({ piEngine: engine, piExecutablePath: engine === 'pi' ? (process.env.PI_EXECUTABLE || 'pi') : (process.env.OMP_EXECUTABLE || 'omp'), defaultProvider: 'local-probe', defaultModel: 'probe', defaultThinkingLevel: 'off', resumeLastSession: false, openToHomeOnLaunch: true, desktopNotifications: false, suggestNextSteps: false, language: 'en', permissionMode: 'ask-edits', minimizeToTrayOnClose: false }));
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', PI_CODING_AGENT_DIR: piDir, OMP_CODING_AGENT_DIR: ompDir, PI_DESKTOP_USER_DATA_DIR: gui, PROBE_ROOT: dir, PROBE_REPO: repo, PROBE_ENGINE: engine };
  const electron = require(path.join(repo, 'node_modules', 'electron'));
  const log = fs.openSync(path.join(dir, 'native.log'), 'w');
  const child = spawn(electron, [path.join(__dirname, mode === 'main' ? 'native-main.cjs' : 'native-popup.cjs')], { cwd: repo, env, stdio: ['ignore', log, log] });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 120000);
  child.on('exit', code => {
    clearTimeout(timeout); server.close(); fs.closeSync(log); record();
    console.log('ARTIFACTS', dir);
    console.log(fs.readFileSync(path.join(dir, 'native.log'), 'utf8').split('\n').filter(l => /PROBE|Error:|error:|Unknown/.test(l)).slice(-30).join('\n'));
    process.exitCode = code || 0;
    const result = path.join(dir, 'results.json');
    if (!fs.existsSync(result) || JSON.parse(fs.readFileSync(result)).error) process.exitCode = 1;
  });
});
