// The title of the browser tab (and of the page Google renders) after the app has loaded (real Chrome over CDP, LOCAL stack only):
//   BASE_URL=http://localhost:18083 node tests/ui/title_check.mjs [chromePath]
// Needs the seeded UI test stack. Sets and restores the channel name and custom title for the check.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBase } from './guard.mjs';
const chromePath = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = localBase(process.env.BASE_URL);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };
const profile = mkdtempSync(join(tmpdir(), 'title-check-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9391', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9391/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const open = async (path, wait = 6000) => { await send('Page.navigate', { url: BASE + path }); await sleep(wait); return ev('document.title'); };
const api = (path, body) => ev(`fetch(${JSON.stringify(path)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
try {
  await send('Page.enable');
  await open('/auth/dev-login', 1500);
  const settings = await ev(`fetch('/api/admin/settings/get').then(r => r.json())`);
  await ev(`fetch('/api/admin/edit-channel-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', description: '', logoUrl: '' }) }).then(r => r.status)`);
  const DEFAULT = 'שקיפות - חדשות ועדכונים';

  check('no channel name: the tab says "שקיפות - חדשות ועדכונים" (not "TheChannel")', (await open('/')) === DEFAULT, await ev('document.title'));
  check('the title does not contain "TheChannel" after the app has loaded', !(await ev('document.title')).includes('TheChannel'));
  const priv = await open('/privacy'); check('privacy page keeps its own title', priv.startsWith('מדיניות פרטיות'), priv);
  const msgId = await ev(`fetch('/api/messages?offset=0&limit=50&direction=desc').then(r => r.json()).then(m => (m.find(x => (x.text||'').includes('זהו טקסט ארוך')) || {}).id)`);
  const mp = await open('/m/' + msgId); check('a message page keeps the title made from its text (not the channel name)', mp.includes('עדכון ארוך') && mp.endsWith('| שקיפות'), mp);

  await ev(`fetch('/api/admin/edit-channel-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ערוץ בדיקה', description: 'x', logoUrl: '' }) }).then(r => r.status)`);
  check('a channel name that was set is the title of the home page', (await open('/')) === 'ערוץ בדיקה', await ev('document.title'));
  await ev(`fetch('/api/admin/settings/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(settings)}.concat([{ key: 'custom_title', value: 'כותרת מותאמת' }])) }).then(r => r.status)`);
  check('a custom title wins over the channel name', (await open('/')) === 'כותרת מותאמת', await ev('document.title'));
} catch (e) { console.log('ERROR', e); results.push(false); }
// restore
try {
  const s = await ev(`fetch('/api/admin/settings/get').then(r => r.json())`);
  await ev(`fetch('/api/admin/settings/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify((s || []).filter(x => x.key !== 'custom_title'))}) }).then(r => r.status)`);
  await ev(`fetch('/api/admin/edit-channel-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', description: '', logoUrl: '' }) }).then(r => r.status)`);
} catch {}
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nFAILED');
process.exit(results.every(Boolean) ? 0 : 1);
