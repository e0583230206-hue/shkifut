// The "share the site" button under a message (the page /m/<id>) in a real Chrome: on a computer the list has "copy link" and e-mail only, on a phone WhatsApp too.
//   node tests/ui/share_button_check.mjs [outDir] [chromePath]        (LOCAL stack only, http://localhost:18080 by default; BASE_URL changes it)
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

const profile = mkdtempSync(join(tmpdir(), 'share-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9478', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9478/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { if (!outDir) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); };

try {
  await send('Page.enable'); await send('Runtime.enable');
  const items = `[...document.querySelectorAll('.share-menu .share-option')].map(e => e.innerText.trim())`;
  const open = async () => { await send('Page.navigate', { url: `${BASE}/m/${id}` }); await sleep(6000); await ev(`document.querySelector('.share-button')?.click()`); await sleep(600); };

  // 1. a computer
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await open();
  check('a "שתפו את האתר" button is on the message', (await ev(`!!document.querySelector('.share-button')`)));
  let list = await ev(items);
  check('computer: the list has copy link and e-mail', list.some(x => x.includes('העתק קישור')) && list.some(x => x.includes('שלח במייל')), JSON.stringify(list));
  check('computer: NO WhatsApp', !list.some(x => x.includes('וואטסאפ')), JSON.stringify(list));
  const mail = await ev(`[...document.querySelectorAll('.share-option')].find(e => e.innerText.includes('מייל'))?.getAttribute('href')`);
  check('computer: the e-mail link carries the address of the SITE (not of the message)', !!mail && mail.startsWith('https://mail.google.com/mail/?view=cm') && decodeURIComponent(mail).includes(`${BASE}/`) && !decodeURIComponent(mail).includes(`/m/${id}`) && !decodeURIComponent(mail).includes('embedded'), mail);
  await shot('share-computer.png');

  // the small link icon above the message shares THAT message (its own address and its title)
  const openIcon = async () => { await send('Page.navigate', { url: `${BASE}/m/${id}` }); await sleep(6000); await ev(`document.querySelector('button[title="שתף את ההודעה"]')?.click()`); await sleep(600); };
  await openIcon();
  list = await ev(items);
  check('computer, message icon: copy link and e-mail, no WhatsApp', list.some(x => x.includes('העתק קישור להודעה')) && list.some(x => x.includes('מייל')) && !list.some(x => x.includes('וואטסאפ')), JSON.stringify(list));
  const mmail = decodeURIComponent(await ev(`[...document.querySelectorAll('.share-option')].find(e => e.innerText.includes('מייל'))?.getAttribute('href') || ''`));
  check('computer, message icon: the e-mail carries the title and the address of the MESSAGE', mmail.includes('ידיעה לדוגמה') && mmail.includes(`/m/${id}`) && !mmail.includes('embedded'), mmail);

  // 2. a phone
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await open();
  list = await ev(items);
  check('phone: the list has copy link, WhatsApp and e-mail', list.some(x => x.includes('העתק קישור')) && list.some(x => x.includes('וואטסאפ')) && list.some(x => x.includes('מייל')), JSON.stringify(list));
  const wa = await ev(`[...document.querySelectorAll('.share-option')].find(e => e.innerText.includes('וואטסאפ'))?.getAttribute('href')`);
  check('phone: the WhatsApp link is wa.me with the address of the SITE', !!wa && wa.startsWith('https://wa.me/?text=') && decodeURIComponent(wa).includes(`${BASE}/`) && !decodeURIComponent(wa).includes(`/m/${id}`), wa);
  const pmail = await ev(`[...document.querySelectorAll('.share-option')].find(e => e.innerText.includes('מייל'))?.getAttribute('href') || ''`);
  check('phone: the e-mail link is a mailto: draft (opens the mail app) with the address of the SITE', pmail.startsWith('mailto:?subject=') && decodeURIComponent(pmail).includes(`${BASE}/`) && !decodeURIComponent(pmail).includes(`/m/${id}`), pmail);
  check('phone: the e-mail link opens in place (no new tab)', (await ev(`[...document.querySelectorAll('.share-option')].find(e => e.innerText.includes('מייל'))?.hasAttribute('target')`)) === false);
  check('phone: no horizontal scroll', (await ev('document.documentElement.scrollWidth <= window.innerWidth')));
  await shot('share-phone.png');
  await openIcon();
  list = await ev(items);
  check('phone, message icon: copy link, WhatsApp and e-mail', list.some(x => x.includes('העתק קישור להודעה')) && list.some(x => x.includes('וואטסאפ')) && list.some(x => x.includes('מייל')), JSON.stringify(list));
  const mwa = decodeURIComponent(await ev(`[...document.querySelectorAll('.share-option')].find(e => e.innerText.includes('וואטסאפ'))?.getAttribute('href') || ''`));
  check('phone, message icon: the WhatsApp link carries the title and the address of the MESSAGE', mwa.startsWith('https://wa.me/?text=') && mwa.includes('ידיעה לדוגמה') && mwa.includes(`/m/${id}`), mwa);
  const pmmail = decodeURIComponent(await ev(`[...document.querySelectorAll('.share-option')].find(e => e.innerText.includes('מייל'))?.getAttribute('href') || ''`));
  check('phone, message icon: the e-mail is a mailto: draft with the title and the address of the MESSAGE', pmmail.startsWith('mailto:?subject=') && pmmail.includes('ידיעה לדוגמה') && pmmail.includes(`/m/${id}`), pmmail);
  await shot('share-phone-icon.png');
} finally {
  ws.close(); proc.kill();
  await api(`/api/admin/delete-message/${id}`);
}
console.log(results.every(Boolean) ? '\nALL PASSED' : `\n${results.filter(x => !x).length} FAILED`);
process.exit(results.every(Boolean) ? 0 : 1);
