// Screenshot of the admin tab "מחוברים" in a real Chrome (CDP), against the LOCAL stack:
//   BASE_URL=http://localhost:18080 node tests/ui/presence_screenshot.mjs <outDir> [chromePath]
// Seeds a few readers (one with an open live connection), opens the admin panel as the owner, clicks the tab, saves 1-presence.png.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir, chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
if (!outDir) { console.error('usage: presence_screenshot.mjs <outDir> [chrome]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };
const redis = (...a) => execFileSync('docker', ['exec', 'thechannel-local-redis-1', 'redis-cli', '-s', '/data/kvrocks.sock', ...a]).toString();

// seed: readers who were here earlier (no connection) and one with an open connection
const now = Math.floor(Date.now() / 1000);
const seeded = { 'dana@example.com': now - 2 * 3600, 'yossi@example.com': now - 26 * 3600, 'ruti@example.com': now - 9 * 86400 };
for (const [e, t] of Object.entries(seeded)) { redis('ZADD', 'presence:seen', String(t), e); redis('HSET', 'presence:names', e, e.split('@')[0]); }
const dev = async (email) => {
  const r = await fetch(`${BASE}/auth/dev-login?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
};
const cookie = await dev('moshe@example.com');
const ctrl = new AbortController();
fetch(`${BASE}/api/events`, { headers: { cookie }, signal: ctrl.signal }).then(async r => { const rd = r.body.getReader(); while (!(await rd.read()).done); }).catch(() => {});
await fetch(`${BASE}/api/user-info`, { headers: { cookie } });

const profile = mkdtempSync(join(tmpdir(), 'presence-shot-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9341', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--window-size=1200,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch('http://127.0.0.1:9341/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const goto = async (url, wait = 2500) => { await send('Page.navigate', { url }); await sleep(wait); };
try {
  await send('Page.enable');
  await goto(`${BASE}/auth/dev-login`, 1500);
  await goto(`${BASE}/`, 3500);
  await ev(`document.querySelector('nb-user')?.click()`); await sleep(800);
  await ev(`[...document.querySelectorAll('.menu-title')].find(e => e.textContent.includes('ניהול ערוץ'))?.click()`); await sleep(1500);
  const titles = await ev(`[...document.querySelectorAll('admin-dashboard .menu-title')].map(e => e.textContent.trim())`);
  check('admin panel has the tab "מחוברים"', (titles || []).includes('מחוברים'), JSON.stringify(titles));
  await ev(`[...document.querySelectorAll('admin-dashboard .menu-title')].find(e => e.textContent.trim() === 'מחוברים')?.click()`); await sleep(2000);
  const text = await ev(`document.querySelector('app-online-users')?.innerText || ''`);
  check('the tab lists the open connection as online', text.includes('moshe@example.com') && text.includes('מחובר עכשיו'), text.slice(0, 200));
  check('the tab lists the earlier readers with relative times', text.includes('dana@example.com') && text.includes('לפני 2 שעות'), text.slice(0, 300));
  check('the tab shows the online counter', (await ev(`document.querySelector('.online-count')?.textContent`)) !== null);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, '1-presence.png'), Buffer.from(shot.result.data, 'base64')); console.log('saved 1-presence.png');
} finally {
  ctrl.abort(); ws.close(); proc.kill();
  for (const e of [...Object.keys(seeded), 'moshe@example.com']) { redis('ZREM', 'presence:seen', e); redis('HDEL', 'presence:names', e); }
}
process.exit(results.every(Boolean) ? 0 : 1);
