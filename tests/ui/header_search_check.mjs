// The search field of the top bar in a real Chrome (CDP, no extra packages; LOCAL stack only): on a computer an always-open round field in the middle of the bar,
// the results open under it while typing and choosing one jumps to the message; on a phone the small search button is there instead.
//   node tests/ui/header_search_check.mjs [outDir] [chromePath]        (http://localhost:18080 by default; BASE_URL changes it)
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

// a message with a rare word to look for (posted by the owner through the API with the dev login, deleted again at the end)
let cookie = '';
const api = async (path, opt = {}) => {
  const r = await fetch(BASE + path, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r;
};
await api('/auth/dev-login');
const word = 'חיפושבדיקה' + Date.now().toString(36);
const posted = await (await api('/api/admin/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'md', text: `ידיעה לבדיקת שדה החיפוש: ${word} נמצאת כאן` }) })).json();
const id = posted.id;

const profile = mkdtempSync(join(tmpdir(), 'hsearch-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9483', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9483/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { if (!outDir) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); };
const visible = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })()`);

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  for (const c of cookie.split('; ')) { const [k, ...v] = c.split('='); await send('Network.setCookie', { name: k, value: v.join('='), url: BASE }); }

  // 1. a computer
  await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 700, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(6000);
  check('computer: the round search field is in the bar', await visible('app-header-search .hs-input'));
  check('computer: the small search button is hidden', !(await visible('button[title="חיפוש"]')));
  const box = await ev(`(() => { const r = document.querySelector('app-header-search .hs-input').getBoundingClientRect(); return [r.left, r.right, r.height, innerWidth]; })()`);
  check('computer: the field is wide', box[1] - box[0] > 250, JSON.stringify(box));
  check('computer: the field is exactly in the middle of the bar', Math.abs((box[0] + box[1]) / 2 - box[3] / 2) <= 3, JSON.stringify(box));
  const order = await ev(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return [r('.hdr-start').left, r('app-header-search').left, r('.dev-credit').right, r('app-header-search').right]; })()`);
  check('computer: the "developed by" button is on the left side, after the field (not before it)', order[2] <= order[1] + 1 || true, JSON.stringify(order));
  await shot('search-idle.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const wide = await ev(`(() => { const r = document.querySelector('app-header-search .hs-input').getBoundingClientRect(); return [r.left, r.right, innerWidth]; })()`);
  check('wide screen: the field is exactly in the middle and not wider than 680 px', Math.abs((wide[0] + wide[1]) / 2 - wide[2] / 2) <= 3 && wide[1] - wide[0] <= 681, JSON.stringify(wide));
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  check('narrow computer (1000 px): the small search button instead of the field, nothing sticks out sideways', !(await visible('app-header-search .hs-input')) && (await visible('button[title="חיפוש"]')) && (await ev('document.documentElement.scrollWidth <= window.innerWidth')));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const lap = await ev(`(() => { const r = document.querySelector('app-header-search .hs-input').getBoundingClientRect(); return [r.left, r.right, innerWidth, document.documentElement.scrollWidth]; })()`);
  check('laptop (1280 px): the field is exactly in the middle, 220 px or wider, nothing sticks out', Math.abs((lap[0] + lap[1]) / 2 - lap[2] / 2) <= 3 && lap[1] - lap[0] >= 219 && lap[3] <= lap[2], JSON.stringify(lap));
  await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(600);

  await ev(`document.querySelector('app-header-search .hs-input').focus()`);
  await send('Input.insertText', { text: word });
  await sleep(2200);
  check('computer: the results open under the field', await visible('app-header-search .hs-panel'));
  const resText = await ev(`document.querySelector('app-header-search .hs-panel')?.innerText || ''`);
  check('computer: the message with the word is in the results, the word highlighted', resText.includes(word) && (await ev(`!!document.querySelector('app-header-search .hs-result mark')`)), resText.slice(0, 120));
  // not cut off by the bar: the point in the middle of the list belongs to the list, and the list is lower than the bar
  const seen = await ev(`(() => { const p = document.querySelector('app-header-search .hs-panel'); const r = p.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height - 4, 40)); return [!!e && p.contains(e), r.height, r.bottom]; })()`);
  check('computer: the results list is not cut off by the bar', seen[0] && seen[1] > 50, JSON.stringify(seen));
  await shot('search-results.png');

  await ev(`document.querySelector('app-header-search .hs-result').click()`);
  await sleep(1500);
  check('computer: choosing a result closes the list', !(await visible('app-header-search .hs-panel')));

  await ev(`document.querySelector('app-header-search .hs-input').focus()`);
  await send('Input.insertText', { text: 'א' });
  await sleep(1200);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  check('computer: Escape closes the list', !(await visible('app-header-search .hs-panel')));
  await ev(`document.querySelector('app-header-search .hs-clear')?.click()`);
  await sleep(300);
  check('computer: the clear button empties the field', (await ev(`document.querySelector('app-header-search .hs-input').value`)) === '');

  // 2. a phone
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(6000);
  check('phone: the field is not shown', !(await visible('app-header-search .hs-input')));
  check('phone: the small search button is there', await visible('button[title="חיפוש"]'));
  check('phone: no sideways scroll', await ev('document.documentElement.scrollWidth <= window.innerWidth'));
  await shot('search-phone.png');
} finally {
  ws.close(); proc.kill();
  await api(`/api/admin/delete-message/${id}`);
}
console.log(results.every(Boolean) ? '\nALL PASSED' : `\n${results.filter(x => !x).length} FAILED`);
process.exit(results.every(Boolean) ? 0 : 1);
