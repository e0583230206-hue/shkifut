// The numbers of open reports and contact messages, in a real Chrome (CDP), against the LOCAL stack:
//   BASE_URL=http://localhost:18080 node tests/ui/inbox_badges_check.mjs [screenshotDir] [chromePath]
// Seeds one message, one report on it and one contact message (through the API, as the owner), then checks: a number on the user's picture,
// a number on "ניהול ערוץ" in the user menu, numbers on the tabs "פניות" and "דיווחים" in the admin panel, and that marking the contact message
// as handled lowers the numbers at once. Everything it created is closed / deleted at the end.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBase } from './guard.mjs';

const [outDir, chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
if (outDir) mkdirSync(outDir, { recursive: true });
const BASE = localBase(process.env.BASE_URL);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

const dev = async (email) => {
  const r = await fetch(`${BASE}/auth/dev-login${email ? '?email=' + encodeURIComponent(email) : ''}`, { redirect: 'manual' });
  return (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
};
const cookie = await dev();
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const counts = async () => (await api('GET', '/api/admin/inbox-counts')).body;

const marker = 'inbox-check-' + Math.random().toString(36).slice(2, 8);
const base0 = await counts();
const msg = await api('POST', '/api/admin/new', { type: 'md', text: marker });
const msgId = msg.body?.id;
const rep = await api('POST', '/api/messages/report', { messageId: msgId, reason: 'בדיקת מספרים ' + marker });
const con = await api('POST', '/api/contact', { name: 'בודק', email: 'test@example.com', phone: '', subject: marker, message: 'פנייה לבדיקת המספרים ' + marker, website: '', elapsedMs: 9000 });
check('seed: a message, a report and a contact message were created', !!msgId && rep.status === 200 && con.status === 200, JSON.stringify([msg.status, rep.status, con.status]));
const base1 = await counts();
check('the server counts one more open report and one more contact message', base1.reports === base0.reports + 1 && base1.contact === base0.contact + 1, JSON.stringify([base0, base1]));

const profile = mkdtempSync(join(tmpdir(), 'inbox-check-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9342', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--window-size=1300,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch('http://127.0.0.1:9342/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const goto = async (url, wait = 2500) => { await send('Page.navigate', { url }); await sleep(wait); };
const shot = async (name) => { if (!outDir) return; const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(s.result.data, 'base64')); };
const badgeNextTo = (title) => `(() => { const t = [...document.querySelectorAll('.menu-title')].find(e => e.textContent.trim() === ${JSON.stringify(title)}); const a = t?.closest('a'); return a?.querySelector('nb-badge')?.textContent.trim() ?? null; })()`;
const total = base1.reports + base1.contact;

try {
  await send('Page.enable');
  await goto(`${BASE}/auth/dev-login`, 1500);
  await goto(`${BASE}/`, 4000);
  const dot = await ev(`document.querySelector('.inbox-dot')?.textContent.trim() ?? null`);
  check('a number on the user picture = open reports + open contact messages', dot === String(total), `dot=${dot} expected=${total}`);
  await ev(`document.querySelector('nb-user')?.click()`); await sleep(800);
  check('the user menu shows the same number next to "ניהול ערוץ"', (await ev(badgeNextTo('ניהול ערוץ'))) === String(total), String(await ev(badgeNextTo('ניהול ערוץ'))));
  await shot('1-user-menu.png');
  await ev(`[...document.querySelectorAll('.menu-title')].find(e => e.textContent.includes('ניהול ערוץ'))?.click()`); await sleep(1800);
  check('the tab "פניות" shows the number of open contact messages', (await ev(badgeNextTo('פניות'))) === String(base1.contact), String(await ev(badgeNextTo('פניות'))));
  check('the tab "דיווחים" shows the number of open reports', (await ev(badgeNextTo('דיווחים'))) === String(base1.reports), String(await ev(badgeNextTo('דיווחים'))));
  await shot('2-admin-tabs.png');
  // mark our contact message as handled: the numbers go down without a reload
  await ev(`[...document.querySelectorAll('.menu-title')].find(e => e.textContent.trim() === 'פניות')?.click()`); await sleep(1500);
  await ev(`(() => { const box = [...document.querySelectorAll('app-contact-inbox .border')].find(d => d.innerText.includes(${JSON.stringify(marker)})); [...(box?.querySelectorAll('button') ?? [])].find(b => b.textContent.includes('סמן כטופל'))?.click(); })()`);
  await sleep(1800);
  const after = await counts();
  check('the server now counts one open contact message less', after.contact === base0.contact, JSON.stringify(after));
  check('the tab number went down at once', (await ev(badgeNextTo('פניות'))) === (after.contact ? String(after.contact) : null), String(await ev(badgeNextTo('פניות'))));
  check('the number on the user picture went down too', (await ev(`document.querySelector('.inbox-dot')?.textContent.trim() ?? null`)) === String(after.reports + after.contact), '');
  await shot('3-after-handled.png');
} finally {
  ws.close(); proc.kill();
  // clean up: close our report, mark the contact message handled (if the UI did not), delete the message
  const list = (await api('GET', '/api/admin/reports/get?status=open')).body;
  for (const r of Array.isArray(list) ? list : []) if (r.messageId === msgId) { r.closed = true; r.updatedAt = new Date().toISOString(); await api('POST', '/api/admin/reports/set', r); }
  const cl = (await api('GET', '/api/admin/contact')).body;
  for (const c of Array.isArray(cl) ? cl : []) if ((c.subject || '').includes(marker)) await api('POST', '/api/admin/contact/set', { id: c.id, handled: true });
  if (msgId) await api('GET', `/api/admin/delete-message/${msgId}`);
}
process.exit(results.every(Boolean) ? 0 : 1);
