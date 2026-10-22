// Browser check of the light / dark / system switch (real Chrome over CDP, LOCAL stack):
//   BASE_URL=http://localhost:18080 node tests/ui/theme_check.mjs <outDir> [chromePath]
// Media in the feed is hidden in the screenshots (they are only about the theme).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir, chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
if (!outDir) { console.error('usage: theme_check.mjs <outDir> [chrome]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
import { localBase } from './guard.mjs';
const BASE = localBase(process.env.BASE_URL);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

const profile = mkdtempSync(join(tmpdir(), 'theme-check-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9351', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--window-size=1100,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch('http://127.0.0.1:9351/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const goto = async (url, wait = 3500) => { await send('Page.navigate', { url }); await sleep(wait); };
const HIDE = `(() => { if (!document.getElementById('hide-media')) { const s = document.createElement('style'); s.id = 'hide-media'; s.textContent = '.mod-wrap img, .mod-wrap video, .msg-gallery img, img.mod-media { visibility: hidden !important }'; document.head.appendChild(s); } })()`;
const shot = async (name) => {
  await ev(HIDE);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name);
};
const bodyClass = () => ev(`[...document.body.classList].find(c => c.startsWith('nb-theme-'))`);
const bodyBg = () => ev(`(() => { let e = document.querySelector('nb-layout-column') || document.body; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; e = e.parentElement; } return 'rgb(255, 255, 255)'; })()`);
const lum = (rgb) => { const m = (rgb || '').match(/\d+/g)?.map(Number) || [255, 255, 255]; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
const choose = async (label) => {
  await ev(`document.querySelector('.theme-switch')?.click()`); await sleep(500);
  const ok = await ev(`(() => { const t = [...document.querySelectorAll('.menu-title')].find(e => e.textContent.trim() === ${JSON.stringify(label)}); if (t) { t.click(); return true; } return false; })()`);
  await sleep(1200);
  return ok;
};

try {
  await send('Page.enable'); await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await goto(`${BASE}/auth/dev-login`, 1500);
  await goto(`${BASE}/`);
  check('the switch button is in the header, next to search', await ev(`!!document.querySelector('.theme-switch') && !!document.querySelector('[aria-label="חיפוש בערוץ"]')`));
  check('default theme is light', (await bodyClass()) === 'nb-theme-custom', await bodyClass());
  await shot('1-light.png');

  await ev(`document.querySelector('.theme-switch')?.click()`); await sleep(600);
  const items = await ev(`[...document.querySelectorAll('.menu-title')].map(e => e.textContent.trim())`);
  check('the menu offers light, dark and system', ['בהיר', 'כהה', 'לפי המערכת'].every(x => (items || []).includes(x)), JSON.stringify(items));
  await shot('2-menu.png');
  await ev(`document.body.click()`); await sleep(300);

  check('choose dark: switched', await choose('כהה'));
  check('dark theme class on the page', (await bodyClass()) === 'nb-theme-custom-dark', await bodyClass());
  check('dark: the page background is dark', lum(await bodyBg()) < 0.35, await bodyBg());
  check('dark: the choice is saved', (await ev(`localStorage.getItem('tc-theme')`)) === 'dark');
  await shot('3-dark.png');

  await goto(`${BASE}/`, 2500);
  check('after a reload it is still dark (first paint)', (await bodyClass()) === 'nb-theme-custom-dark', await bodyClass());

  // admin panel + the "online" tab in dark
  await ev(`document.querySelector('nb-user')?.click()`); await sleep(700);
  await ev(`[...document.querySelectorAll('.menu-title')].find(e => e.textContent.includes('ניהול ערוץ'))?.click()`); await sleep(1500);
  await ev(`[...document.querySelectorAll('admin-dashboard .menu-title')].find(e => e.textContent.trim() === 'מחוברים')?.click()`); await sleep(1500);
  await shot('4-dark-admin.png');
  await goto(`${BASE}/privacy`, 2500);
  await shot('5-dark-privacy.png');
  await goto(`${BASE}/`, 2500);

  // system: follows the device, and changes live
  check('choose system: switched', await choose('לפי המערכת'));
  check('system + light device = light', (await bodyClass()) === 'nb-theme-custom', await bodyClass());
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(1200);
  check('system: the device turns dark -> the page follows live', (await bodyClass()) === 'nb-theme-custom-dark', await bodyClass());
  check('system: saved as "system"', (await ev(`localStorage.getItem('tc-theme')`)) === 'system');
  await shot('6-system-dark.png');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await sleep(1200);
  check('system: the device turns light -> the page follows live', (await bodyClass()) === 'nb-theme-custom', await bodyClass());

  // light always light, even on a dark device
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  check('choose light: switched', await choose('בהיר'));
  check('light stays light on a dark device', (await bodyClass()) === 'nb-theme-custom', await bodyClass());
  check('light: the background is light', lum(await bodyBg()) > 0.7, await bodyBg());
} finally {
  ws.close(); proc.kill();
}
process.exit(results.every(Boolean) ? 0 : 1);
