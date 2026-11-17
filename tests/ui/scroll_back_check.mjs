// Scrolling back (older messages) as a reader: no message twice, and it reaches the oldest one.
// Real Chrome over CDP, LOCAL stack only. Run through tests/e2e_scroll_back.py, which seeds the messages
// (one of them "released after being held": low id, newest time) and passes their ids.
//   node tests/ui/scroll_back_check.mjs http://localhost:18080 <oldestId> <id,id,...>
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [base, oldest, idsArg] = process.argv.slice(2);
if (!/^http:\/\/localhost:\d+$/.test(base || '') || /:(8080|8081)$/.test(base)) { console.error('local stack only'); process.exit(2); }
const seeded = new Set(idsArg.split(',').map(Number));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9398', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'scrback-'))}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9398/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/' }); await sleep(6000);
const shown = () => ev(`JSON.stringify([...document.querySelectorAll('nb-list-item app-message[id]')].map(e => Number(e.id)))`).then(JSON.parse);
let ids = [];
for (let i = 0; i < 25; i++) {
  await ev('window.scrollTo(0, 0)'); await sleep(1600); // the list loads older messages near the top, at most once a second
  await ev('window.scrollTo(0, 200)'); await sleep(200);
  ids = (await shown()).filter(x => seeded.has(x));
  if (ids.includes(Number(oldest))) break;
}
const repeats = ids.length - new Set(ids).size;
console.log(JSON.stringify({ shown: ids.length, seeded: seeded.size, repeats, reachedOldest: ids.includes(Number(oldest)) }));
try { ws.close(); proc.kill(); } catch {}
process.exit(repeats === 0 && ids.includes(Number(oldest)) ? 0 : 1);
