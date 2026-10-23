// Screenshots of the header and the ad column at 2048, 1280 and 360 px (real Chrome over CDP).
//   node tests/ui/header_ad_shots.mjs <outDir> <label> <url> [setup]
// url: the LOCAL UI test stack (http://localhost:18083) or the live site (read only). "setup" (local stack only): sets an ad (adaptive embed
// code, column 580 px) before the shots. Nothing else is changed.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [outDir, label, base, setup] = process.argv.slice(2);
if (!outDir || !label || !base) { console.error('usage: header_ad_shots.mjs <outDir> <label> <url> [setup]'); process.exit(2); }
if (setup && !/^http:\/\/localhost:\d+$/.test(base)) { console.error('setup only on the local stack'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'hdr-'));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9398', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9398/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
await send('Page.enable');
if (setup) {
  await send('Page.navigate', { url: base + '/auth/dev-login' }); await sleep(1500);
  const code = `<style>html,body{margin:0;height:100%;overflow:hidden;background:#0f1320}a{display:flex;align-items:center;justify-content:center;width:100%;height:100vh}img{display:block;max-width:100%;max-height:100vh;width:auto;height:auto}</style><a href="https://hashkifut.co.il" target="_blank" rel="noopener"><img src="https://hashkifut.co.il/ad-assets/ad-vertical.gif" alt="שקיפות"></a>`;
  const cur = await ev(`fetch('/api/admin/settings/get').then(r => r.json())`) || [];
  const rest = cur.filter(s => !['ads_enabled', 'ads_embed_code', 'ad-iframe-width', 'ads_feed_every'].includes(s.key));
  console.log('settings saved:', await ev(`fetch('/api/admin/settings/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(rest.concat([{ key: 'ads_enabled', value: true }, { key: 'ads_embed_code', value: code }, { key: 'ad-iframe-width', value: 580 }, { key: 'ads_feed_every', value: 0 }]))}) }).then(r => r.status)`));
}
for (const [name, w, h, mobile] of [['2048', 2048, 1080, false], ['1280', 1280, 800, false], ['360', 360, 740, true]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await send('Page.navigate', { url: base + '/' }); await sleep(8000);
  await ev('window.scrollTo(0, 0)');
  const m = await ev(`JSON.stringify((() => { const hd = document.querySelector('app-channel-header'); const r = hd.getBoundingClientRect(); const f = document.querySelector('iframe[title="פרסומת"]'); const fr = f && f.getBoundingClientRect(); const first = document.querySelector('app-message .message-card')?.getBoundingClientRect(); return { headerBottom: Math.round(r.bottom), adFrame: fr && [Math.round(fr.width), Math.round(fr.height)], scrollW: document.documentElement.scrollWidth, innerW: innerWidth }; })())`);
  console.log(`[${label} ${name}]`, m);
  await shot(`${label}-${name}.png`);
}
try { ws.close(); proc.kill(); } catch {}
process.exit(0);
