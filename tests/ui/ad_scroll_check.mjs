// Does the ad column stay put while the page scrolls? (real Chrome over CDP, LOCAL stack only)
//   node tests/ui/ad_scroll_check.mjs http://localhost:18083 [admin]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [base, who] = process.argv.slice(2);
if (!/^http:\/\/localhost:\d+$/.test(base || '')) { console.error('local stack only'); process.exit(2); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9399', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'adscr-'))}`, '--headless=new', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9399/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
if (who === 'admin') { await send('Page.navigate', { url: base + '/auth/dev-login' }); await sleep(1500); }
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/' }); await sleep(7000);
for (const y of [0, 300, 800, 1500, 99999, 400, 0]) {
  await ev(`window.scrollTo(0, ${y})`); await sleep(500);
  console.log(await ev(`JSON.stringify((() => { const a = document.querySelector('app-advertising').getBoundingClientRect(); const f = document.querySelector('iframe[title="פרסומת"]')?.getBoundingClientRect(); const sc = [document.scrollingElement.scrollTop, ...[...document.querySelectorAll('*')].filter(e => e.scrollTop > 0).map(e => e.tagName + ':' + e.scrollTop)]; return { want: ${y}, scroll: sc, adTop: Math.round(a.top), adBottom: Math.round(a.bottom), frameTop: f && Math.round(f.top), docH: document.documentElement.scrollHeight }; })())`));
}
try { ws.close(); proc.kill(); } catch {}
process.exit(0);
