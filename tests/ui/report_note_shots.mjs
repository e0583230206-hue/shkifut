// Screenshots of the "report problematic content" note: desktop (side column, under the ad) and phone (end of the page). LOCAL stack only.
//   node tests/ui/report_note_shots.mjs <outDir> http://localhost:18083
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [outDir, base] = process.argv.slice(2);
if (!outDir || !/^http:\/\/localhost:\d+$/.test(base || '')) { console.error('usage: report_note_shots.mjs <outDir> <local url>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9401', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rn-'))}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9401/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
for (const [name, w, h, mobile] of [['2048', 2048, 1080, false], ['1280', 1280, 800, false], ['360', 360, 740, true]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await send('Page.navigate', { url: base + '/' }); await sleep(7000);
  await ev('window.scrollTo(0, 99999)'); await sleep(900);
  console.log(name, await ev(`JSON.stringify([...document.querySelectorAll('.report-note')].map(e => { const r = e.getBoundingClientRect(); return { visible: r.width > 0, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), href: e.querySelector('a').getAttribute('href').slice(0, 40) }; }))`),
    'frame', await ev(`(() => { const f = document.querySelector('iframe[title="פרסומת"]')?.getBoundingClientRect(); return f && JSON.stringify([Math.round(f.top), Math.round(f.bottom), Math.round(f.width)]); })()`), 'scrollW', await ev('document.documentElement.scrollWidth'), 'innerW', await ev('innerWidth'));
  const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, `report-${name}.png`), Buffer.from(r.result.data, 'base64'));
}
try { ws.close(); proc.kill(); } catch {}
process.exit(0);
