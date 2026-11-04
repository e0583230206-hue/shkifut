// The notice "the site was updated" in a real Chrome: the page carries its version, /api/version is answered with another one (simulated), the notice
// appears, "not now" hides it, and the button refreshes the page.
//   node tests/ui/update_banner_check.mjs [outDir] [chromePath]        (LOCAL stack only, http://localhost:18080 by default; BASE_URL changes it)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBase } from './guard.mjs';

const [outDir = '', chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
const BASE = localBase(process.env.BASE_URL);
if (outDir) mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

// a message to look at: posted by the owner through the API (dev login), deleted again at the end
let cookie = '';
const api = async (path, opt = {}) => {
  const r = await fetch(BASE + path, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r;
};
await api('/auth/dev-login');
const text = 'בדיקת שיתוף: **ידיעה לדוגמה** שנכתבה כדי לבדוק את כפתור השיתוף & עוד. ' + Date.now();
const posted = await (await api('/api/admin/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'md', text }) })).json();
const id = posted.id;

const profile = mkdtempSync(join(tmpdir(), 'update-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9479', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9479/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { if (!outDir) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); };

try {
  await send('Page.enable'); await send('Runtime.enable');
  let fake = '';   // when set, /api/version answers with it
  ws.addEventListener('message', async (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Fetch.requestPaused') {
      if (fake) await send('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ version: fake })).toString('base64') });
      else await send('Fetch.continueRequest', { requestId: d.params.requestId });
    }
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/version*' }] });
  const bannerShown = () => ev(`!!document.querySelector('.update-banner')`);
  const poke = async () => { await ev(`document.dispatchEvent(new Event('visibilitychange'))`); await sleep(1200); };

  await send('Page.navigate', { url: `${BASE}/m/${id}` });
  await sleep(6000);
  const loaded = await ev(`document.querySelector('meta[name="app-version"]')?.content || ''`);
  check('the page carries its version (12 hex digits)', /^[0-9a-f]{12}$/.test(loaded), loaded);
  const served = await (await fetch(`${BASE}/api/version`)).json().catch(() => ({}));
  check('/api/version answers the same version', served.version === loaded, JSON.stringify(served));
  await poke();
  check('same version: no notice', !(await bannerShown()));

  fake = 'abcdefabcdef';
  await poke();
  check('a newer version: the notice appears', await bannerShown());
  check('the notice says the site was updated and has a refresh button', (await ev(`document.querySelector('.update-banner')?.innerText || ''`)).includes('עדכנו את האתר') && (await ev(`document.querySelector('.update-banner .refresh')?.innerText || ''`)).includes('לרענון'));
  await shot('update-banner.png');

  await ev(`document.querySelector('.update-banner .close').click()`); await sleep(400);
  check('"not now" hides the notice', !(await bannerShown()));
  await poke();
  check('... and it stays hidden for the same version', !(await bannerShown()));
  fake = '123456123456';
  await poke();
  check('... but comes back for an even newer version', await bannerShown());

  // a phone: the card fits the screen (no sideways scroll, all of it inside the window)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/m/${id}` });
  await sleep(6000);
  fake = 'fedcbafedcba';
  await poke();
  await sleep(900);
  const box = await ev(`(() => { const r = document.querySelector('.update-banner')?.getBoundingClientRect(); return r ? [r.left, r.right, r.bottom, window.innerWidth, window.innerHeight] : null; })()`);
  check('phone: the notice is inside the screen', !!box && box[0] >= 0 && box[1] <= box[3] && box[2] <= box[4], JSON.stringify(box));
  check('phone: no sideways scroll', await ev('document.documentElement.scrollWidth <= window.innerWidth'));
  await shot('update-banner-phone.png');
  await send('Emulation.clearDeviceMetricsOverride');

  fake = '';
  await ev(`window.__oldPage = true`);
  await ev(`document.querySelector('.update-banner .refresh').click()`);
  await sleep(6000);
  check('the button refreshes the page', (await ev(`window.__oldPage === true`)) === false && (await ev(`document.querySelector('meta[name="app-version"]')?.content || ''`)) === loaded);
  check('after the refresh there is no notice', !(await bannerShown()));
} finally {
  ws.close(); proc.kill();
  await api(`/api/admin/delete-message/${id}`);
}
console.log(results.every(Boolean) ? '\nALL PASSED' : `\n${results.filter(x => !x).length} FAILED`);
process.exit(results.every(Boolean) ? 0 : 1);
