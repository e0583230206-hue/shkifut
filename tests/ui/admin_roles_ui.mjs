// The two kinds of managers in a real Chrome (CDP): what each of them sees on the page, and the permissions screen of the owner (the new checkboxes
// "מנהל 1" / "מנהל 2" with their explanation). LOCAL stack only: the UI test stack started with tests/docker-compose.roles-test.yml and the page built with
// `ng build --configuration development`.
//   node tests/ui/admin_roles_ui.mjs <outDir> http://localhost:18083
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [outDir, base] = process.argv.slice(2);
if (!outDir || !/^http:\/\/localhost:\d+$/.test(base || '') || /:(8080|8081)$/.test(base)) { console.error('usage: admin_roles_ui.mjs <outDir> <local url>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

// ---- setup through the API: two managers, a picture in the channel ----
let cookie = '';
const api = async (path, opt = {}) => {
  const r = await fetch(base + path, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r;
};
const post = (path, obj) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
await api('/auth/dev-login');
const users0 = await (await api('/api/admin/privilegs-users/get-list')).json();
const M1 = 'manager-one@example.com', M2 = 'manager-two@example.com';
const u = (email, flags) => ({ id: '', username: email.split('@')[0], email, publicName: email.split('@')[0], privileges: flags });
await post('/api/admin/privilegs-users/set', { list: [...users0, u(M1, { moderator: true }), u(M2, { reviewer: true })] });
const fd = new FormData();
fd.append('file', new Blob([Buffer.concat([readFileSync(join(MEDIA, 'landscape_hermon.jpg')), Buffer.from(String(Math.random()))])], { type: 'image/jpeg' }), 'a.jpg');
const up = await (await api('/api/admin/upload', { method: 'POST', body: fd })).json();
const img = up.url.match(/\/api\/files\/([0-9a-f]{40})/)[1];
await post('/api/admin/files/moderation', { id: img, status: 'open' });
await post('/api/admin/new', { type: 'md', text: `תמונה לבדיקת הרשאות\n[image-embedded#](${up.url})` });

// ---- Chrome ----
const profile = mkdtempSync(join(tmpdir(), 'rolesui-'));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9409', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9409/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('  js error:', r.result.exceptionDetails.exception?.description?.slice(0, 200)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(150); } return false; };
const clickText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
const loginAs = async (email) => {
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url: base + '/auth/dev-login' + (email ? `?email=${email}` : '') }); await sleep(1200);
  await send('Page.navigate', { url: base + '/' });
  await waitFor(`!!document.querySelector('.mod-wrap[data-file-id="${img}"]')`, 30000); await sleep(800);
};
const bar = () => ev(`(document.querySelector('.mod-wrap[data-file-id="${img}"] .mod-bar')?.textContent || '')`);
const menuItems = async () => {
  await ev(`document.querySelector('nb-user')?.click()`); await sleep(500);
  const items = await ev(`[...document.querySelectorAll('.menu-title')].map(e => e.textContent.trim()).join('|')`);
  await ev(`document.body.click()`); await sleep(300);
  return items;
};

try {
  await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // manager 2: the media tools on the picture, and no channel management
  await loginAs(M2);
  const b2 = await bar();
  check('manager 2: sees the moderator bar on a picture, with "פתח לכולם / טשטוש / בדוק מחדש / טשטוש ידני / בדיקת דמויות"', ['טשטוש', 'בדוק מחדש', 'טשטוש ידני', 'בדיקת דמויות'].every(w => b2.includes(w)), b2);
  const m2 = await menuItems();
  check('manager 2: the user menu has no "ניהול ערוץ"', !m2.includes('ניהול ערוץ') && m2.includes('התנתק'), m2);

  // manager 1: the media tools and the channel management (contact, online)
  await loginAs(M1);
  const b1 = await bar();
  check('manager 1: the same media tools', ['טשטוש', 'בדוק מחדש', 'טשטוש ידני', 'בדיקת דמויות'].every(w => b1.includes(w)), b1);
  const m1 = await menuItems();
  check('manager 1: the user menu has "ניהול ערוץ"', m1.includes('ניהול ערוץ'), m1);
  await ev(`document.querySelector('nb-user')?.click()`); await sleep(400);
  await clickText('.menu-title', 'ניהול ערוץ'); await sleep(1500);
  const tabs1 = await ev(`[...document.querySelectorAll('nb-menu .menu-title')].map(e => e.textContent.trim()).join('|')`);
  check('manager 1: the channel management has "פניות" (contact) and "מחוברים" (who is online)', tabs1.includes('פניות') && tabs1.includes('מחוברים'), tabs1);
  await shot('roles-manager1-panel.png');

  // a reader: nothing
  await loginAs('just-a-reader@example.com');
  check('a reader: no moderator bar', !(await bar()).includes('טשטוש'), await bar());

  // the owner: the permissions screen with the two kinds
  await loginAs(null);
  await ev(`document.querySelector('nb-user')?.click()`); await sleep(400);
  await clickText('.menu-title', 'ניהול ערוץ'); await sleep(1500);
  await clickText('nb-menu .menu-title', 'הרשאות'); await sleep(1500);
  const text = await ev(`document.querySelector('app-privileg-dashboard')?.textContent || ''`);
  check('owner: the permissions screen has "מנהל 1" and "מנהל 2" next to "מנהל ראשי" and "כותב"', ['מנהל ראשי', 'מנהל 1', 'מנהל 2', 'כותב'].every(w => text.includes(w)), text.slice(0, 200));
  const boxes = await ev(`document.querySelectorAll('app-privileg-dashboard nb-checkbox').length`);
  check('owner: four checkboxes for every user (and the two managers added above are listed)', boxes >= 4 * 3, boxes);
  await shot('roles-owner-permissions.png');
  await clickText('app-privileg-dashboard button', 'הוסף');
  await sleep(500);
  const help = await ev(`document.querySelector('app-privileg-dashboard .roles-help')?.textContent || ''`);
  check('owner: adding a user explains the three roles', help.includes('צור קשר') && help.includes('מחוברים') && help.includes('הכל'), help.slice(0, 160));
  await shot('roles-owner-add-user.png');
} catch (e) { console.log('ERROR', e); results.push(false); }
await post('/api/admin/privilegs-users/set', { list: users0 });   // the users list as it was
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME CHECKS FAILED');
process.exit(0);
