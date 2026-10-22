// Screenshots + measurements of the message width at 1920, 1280 and 360 px (real Chrome over CDP, LOCAL stack only):
//   BASE_URL=http://localhost:18083 node tests/ui/width_shots.mjs <outDir> <label> [extraCssFile]
// Needs the seeded UI test stack (tests/docker-compose.ui-test.yml + tests/ui/seed_ui_data.py). extraCssFile: CSS injected into the page, to preview a
// layout idea (for example a centred column) without changing the code.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBase } from './guard.mjs';

const [outDir, label, cssFile, chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
if (!outDir || !label) { console.error('usage: width_shots.mjs <outDir> <label> [extraCssFile]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const BASE = localBase(process.env.BASE_URL);
const EXTRA = cssFile && cssFile !== '-' ? readFileSync(cssFile, 'utf8') : '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

const profile = mkdtempSync(join(tmpdir(), 'width-shots-'));
const port = 9371;
const proc = spawn(chromePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
const idOf = (text) => ev(`(() => { const m = [...document.querySelectorAll('app-message')].filter(e => e.textContent.includes(${JSON.stringify(text)})); return m.length ? String(Math.max(...m.map(e => +e.id))) : null; })()`);
const scrollTo = (mid) => ev(`(() => { const e = document.getElementById('${mid}'); if (!e) return false; e.scrollIntoView({ block: 'start' }); window.scrollBy(0, -170); return true; })()`);

try {
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(EXTRA)}; document.head.appendChild(s); });` });
  await send('Page.navigate', { url: `${BASE}/auth/dev-login` }); await sleep(1200);
  for (const [name, w, h, mobile] of [['1920', 1920, 1080, false], ['1280', 1280, 900, false], ['360', 360, 740, true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await send('Page.navigate', { url: `${BASE}/` }); await sleep(5500);
    const m = JSON.parse(await ev(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.message-card')].map(e => e.getBoundingClientRect());
      const rows = [...document.querySelectorAll('.msg-row')].map(e => e.getBoundingClientRect());
      const left = Math.min(...rows.map(r => r.left)), right = Math.max(...rows.map(r => r.right));
      return { cardWidths: [...new Set(cards.map(r => Math.round(r.width)))], rowLeft: Math.round(left), rowRight: Math.round(right),
               gapLeft: Math.round(left), gapRight: Math.round(window.innerWidth - right), scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    })())`));
    console.log(`[${label} ${name}]`, JSON.stringify(m));
    check(`${label} ${name}: all messages have the same width`, m.cardWidths.length === 1, JSON.stringify(m.cardWidths));
    check(`${label} ${name}: no sideways scroll`, m.scrollW <= m.innerW + 1, `${m.scrollW} > ${m.innerW}`);
    if (!mobile) check(`${label} ${name}: width is ${label.startsWith('before') ? 390 : 570} px`, Math.abs(m.cardWidths[0] - (label.startsWith('before') ? 390 : 570)) <= 2 || EXTRA !== '', m.cardWidths[0]);
    else check(`${label} ${name}: fits the phone screen`, m.cardWidths[0] <= w, `${m.cardWidths[0]} of ${w}`);
    // media fills the width of the message; a tall video is never higher than 80% of the screen
    const media = JSON.parse(await ev(`JSON.stringify((() => { const card = document.querySelector('.message-card .mod-wrap:not([data-gallery])')?.closest('.message-card'); const f = card?.querySelector('.mod-frame'); const t = card?.querySelector('markdown'); const tall = [...document.querySelectorAll('.mod-frame-video')].map(e => Math.round(e.getBoundingClientRect().height)); return { frame: f && Math.round(f.getBoundingClientRect().width), text: t && Math.round(t.getBoundingClientRect().width), tall }; })())`));
    check(`${label} ${name}: a picture fills the width of the message`, media.frame && Math.abs(media.frame - media.text) <= 2, JSON.stringify(media));
    check(`${label} ${name}: tall video at most 80% of the screen`, media.tall.every(v => v <= h * 0.8 + 2), JSON.stringify(media.tall));
    await ev('window.scrollTo(0, 0)'); await sleep(400); await shot(`${label}-${name}-1-top.png`);
    for (const [text, nm] of [['תמונה רחבה', '2-wide-image'], ['זהו טקסט ארוך', '3-long-text'], ['סרטון עומד', '4-tall-video'], ['גלריה של שלוש', '5-gallery']]) {
      const mid = await idOf(text); if (!mid) continue;
      await scrollTo(mid); await sleep(900); await shot(`${label}-${name}-${nm}.png`);
    }
  }
} catch (e) { console.log('ERROR', e); results.push(false); }
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME CHECKS FAILED');
process.exit(0);
