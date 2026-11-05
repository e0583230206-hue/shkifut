// The star on a message ("saved messages") and the emoji button at the bottom of a message, in a real Chrome (CDP, no extra packages; LOCAL stack only).
//   node tests/ui/starred_check.mjs [outDir] [chromePath]        (http://localhost:18080 by default; BASE_URL changes it)
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

let cookie = '';
const api = async (path, opt = {}) => {
  const r = await fetch(BASE + path, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r;
};
await api('/auth/dev-login');
// the emoji button is shown only when the channel has a list of reactions: this test sets a small one, and puts back the old one at the end
const oldEmojis = await (await api('/api/emojis/list')).json();
await api('/api/admin/set-emojis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emojis: ['👍', '❤️', '🙏'] }) });
const word = 'כוכביתבדיקה' + Date.now().toString(36);
const posted = await (await api('/api/admin/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'md', text: `הודעה לבדיקת הכוכב: **${word}** נשמרת ברשימה` }) })).json();
const id = posted.id;

const profile = mkdtempSync(join(tmpdir(), 'starred-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9486', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9486/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { if (!outDir) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); };
const visible = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })()`);
const msg = `document.getElementById('${id}')`;
const stored = async () => JSON.parse((await ev(`localStorage.getItem('tc-starred')`)) || '[]');

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  for (const c of cookie.split('; ')) { const [k, ...v] = c.split('='); await send('Network.setCookie', { name: k, value: v.join('='), url: BASE }); }
  await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(6500);
  await ev(`${msg}?.scrollIntoView({ block: 'center' })`); await sleep(500);

  // 1. the emoji button is at the bottom of the message
  const pos = await ev(`(() => { const m = ${msg}; const e = m?.querySelector('.emoji-button'); const t = m?.querySelector('markdown'); if (!e || !t) return null; return { inHead: !!e.closest('.msg-head'), eTop: e.getBoundingClientRect().top, tBottom: t.getBoundingClientRect().bottom }; })()`);
  check('the emoji button is at the bottom of the message (under the text, not in the row above it)', !!pos && !pos.inHead && pos.eTop >= pos.tBottom - 2, JSON.stringify(pos));
  check('the star is in the row above the message', await ev(`!!${msg}?.querySelector('.msg-head .star-button')`));

  // 2. starring
  check('the star starts empty (not pressed)', (await ev(`${msg}.querySelector('.star-button').getAttribute('aria-pressed')`)) === 'false');
  await ev(`${msg}.querySelector('.star-button').click()`); await sleep(250);
  check('the star pops for a moment (the animation class and the burst of sparks)', (await ev(`${msg}.querySelector('.star-button').classList.contains('pop')`)) && (await ev(`${msg}.querySelectorAll('.star-button .star-burst i').length`)) === 6);
  await sleep(300);
  check('a click on the star presses it', (await ev(`${msg}.querySelector('.star-button').getAttribute('aria-pressed')`)) === 'true' && (await ev(`${msg}.querySelector('.star-button').classList.contains('on')`)));
  const s1 = await stored();
  check('it is saved in the browser with a short copy of the text', s1.length === 1 && s1[0].id === id && s1[0].snippet.includes(word) && !s1[0].snippet.includes('**'), JSON.stringify(s1));
  check('the star button of the top bar shows the number', (await ev(`document.querySelector('.star-list-btn .star-badge')?.innerText`)) === '1');
  await sleep(900);
  check('the pop is over after a moment', !(await ev(`${msg}.querySelector('.star-button').classList.contains('pop')`)));
  await shot('starred-message.png');

  // 3. the list
  await ev(`document.querySelector('.star-list-btn').click()`); await sleep(700);
  check('the button of the top bar opens the list of saved messages', await visible('.starred-card'));
  check('the saved message is in it', (await ev(`document.querySelector('.starred-card').innerText`)).includes(word));
  await shot('starred-list.png');
  await ev(`document.querySelector('.starred-item').click()`); await sleep(900);
  check('choosing it closes the list', !(await visible('.starred-card')));
  await ev(`document.querySelector('.star-list-btn').click()`); await sleep(600);
  await ev(`document.querySelector('.starred-remove').click()`); await sleep(400);
  check('the star can be taken away in the list: the list is empty and says so', (await ev(`document.querySelector('.starred-card').innerText`)).includes('עדיין אין הודעות שמורות') && (await stored()).length === 0);
  await ev(`document.querySelector('.starred-card button[aria-label="סגור"]').click()`); await sleep(500);
  check('without stars the number is gone', !(await ev(`!!document.querySelector('.star-list-btn .star-badge')`)));
  check('and the star on the message is empty again', (await ev(`${msg}.querySelector('.star-button').getAttribute('aria-pressed')`)) === 'false');

  // 4. kept after a reload; clear all
  await ev(`${msg}.querySelector('.star-button').click()`); await sleep(400);
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(6500);
  await ev(`${msg}?.scrollIntoView({ block: 'center' })`); await sleep(400);
  check('after a reload the star is still there, and the number', (await ev(`${msg}.querySelector('.star-button').classList.contains('on')`)) && (await ev(`document.querySelector('.star-list-btn .star-badge')?.innerText`)) === '1');
  await ev(`document.querySelector('.star-list-btn').click()`); await sleep(600);
  await ev(`[...document.querySelectorAll('.starred-card nb-card-header button')].find(b => b.innerText.includes('נקה הכל')).click()`); await sleep(400);
  check('"clear all" empties the list', (await stored()).length === 0 && (await ev(`document.querySelector('.starred-card').innerText`)).includes('עדיין אין הודעות שמורות'));
  await ev(`document.querySelector('.starred-card button[aria-label="סגור"]').click()`); await sleep(400);

  // 5. the bar keeps its search field in the middle with the extra button, also with a star on the button
  await ev(`${msg}.querySelector('.star-button').click()`); await sleep(300);
  const mid = await ev(`(() => { const r = document.querySelector('app-header-search .hs-input').getBoundingClientRect(); return [(r.left + r.right) / 2, innerWidth / 2, document.documentElement.scrollWidth, innerWidth]; })()`);
  check('the search field is still exactly in the middle, nothing sticks out', Math.abs(mid[0] - mid[1]) <= 3 && mid[2] <= mid[3], JSON.stringify(mid));
  await ev(`localStorage.removeItem('tc-starred')`);

  // 6. a phone
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(6500);
  check('phone: the star button of the top bar is there', await visible('.star-list-btn'));
  check('phone: no sideways scroll', await ev('document.documentElement.scrollWidth <= window.innerWidth'));
  await ev(`${msg}?.scrollIntoView({ block: 'center' })`); await sleep(500);
  await shot('starred-phone.png');
} finally {
  ws.close(); proc.kill();
  await api(`/api/admin/delete-message/${id}`);
  await api('/api/admin/set-emojis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emojis: oldEmojis }) });
}
console.log(results.every(Boolean) ? '\nALL PASSED' : `\n${results.filter(x => !x).length} FAILED`);
process.exit(results.every(Boolean) ? 0 : 1);
