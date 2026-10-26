// The page of one message (/m/<id>) in a real Chrome (CDP, no extra packages), as a search engine sees it: the page runs its scripts and must
// STAY on /m/<id> (a page that jumps to the home page is a "page with redirect" for Google and is left out of the index).
//   node tests/ui/message_page_check.mjs [outDir] [chromePath]        (LOCAL stack only, http://localhost:18080 by default; BASE_URL changes it)
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
const text = 'בדיקת דף הודעה: **ידיעה לדוגמה** שנכתבה כדי לבדוק שהדף נשאר במקומו ולא קופץ לדף הבית. ' + Date.now();
const posted = await (await api('/api/admin/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'md', text }) })).json();
const id = posted.id;

const profile = mkdtempSync(join(tmpdir(), 'msgpage-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9477', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9477/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { if (!outDir) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); };

try {
  await send('Page.enable'); await send('Runtime.enable');
  // 1. as a visitor without a login (a crawler): open the page, give the scripts time to run
  await send('Page.navigate', { url: `${BASE}/m/${id}` });
  await sleep(6000);
  const where = await ev('location.pathname + location.hash');
  check('the page stays on /m/<id> after its scripts have run (no jump to the home page)', where === `/m/${id}`, where);
  const body = await ev('document.body.innerText');
  check('the message text is in the page that was run (not only in <noscript>)', body.includes('ידיעה לדוגמה'), body.slice(0, 200));
  check('a button "פתח בערוץ" is there', body.includes('פתח בערוץ'));
  check('the channel itself (the list of messages, the writing box) is not on this page', !(await ev(`!!document.querySelector('app-input-form, app-chat')`)));
  await shot('1-message-page.png');

  // 2. the button opens the channel at that message
  await ev(`document.querySelector('.open-link')?.click()`);
  await sleep(4000);
  const after = await ev('location.pathname + location.hash');
  check('the button goes to the channel with the message number (/#<id>)', after === `/#${id}`, after);
  await shot('2-channel-at-message.png');

  // 3. a message that does not exist
  await send('Page.navigate', { url: `${BASE}/m/987654321` });
  await sleep(4000);
  const gone = await ev('document.body.innerText');
  check('a message that does not exist: "ההודעה לא נמצאה", and the page stays', gone.includes('ההודעה לא נמצאה') && (await ev('location.pathname')) === '/m/987654321', gone.slice(0, 120));
} finally {
  ws.close(); proc.kill();
  await api(`/api/admin/delete-message/${id}`);
}
console.log(results.every(Boolean) ? '\nALL PASSED' : `\n${results.filter(x => !x).length} FAILED`);
process.exit(results.every(Boolean) ? 0 : 1);
