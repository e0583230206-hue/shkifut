// Regression: a jump to a message that is NOT on the page, when that message was released from waiting (low id, newest time).
// Before the fix the client built the window by comparing ids, so the released message never loaded (a link to it, or a jump
// from a window of newer messages). The window is now built by time (ChatComponent.loadAround).
//
// ISOLATED stack only (127.0.0.1:18083, project tc-ui), with the held-video flag ON:
//   docker compose -p tc-ui -f docker-compose.local.yml -f <ports override> -f tests/docker-compose.hold-test.yml up -d --no-deps backend
//   node tests/ui/jump_released_check.mjs [chromePath]
// Creates test messages (one held video message, then 60 plain ones, then approves the video), then checks in a browser that
// reader windows (no login) load the released message from a link and from an in-page jump. The test messages stay in the
// isolated store (they are test data; nothing existing is changed).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:18083';
const chromePath = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

// ---- setup through the API (owner session = the default dev login)
const login = await fetch(`${BASE}/auth/dev-login`, { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const api = async (path, body) => {
  const r = await fetch(BASE + path, body === undefined ? { headers: { cookie } }
    : { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};
const mp4 = readFileSync(join(ROOT, 'tests', 'media', 'short.mp4'));
const form = new FormData();
form.append('file', new Blob([Buffer.concat([mp4, randomBytes(16)])], { type: 'video/mp4' }), 'jump-check.mp4');
const up = await (await fetch(BASE + '/api/admin/upload', { method: 'POST', headers: { cookie }, body: form })).json();
const fid = up.url.split('?')[0].split('/').pop().split('.')[0];
const held = await api('/api/admin/new', { type: 'md', text: `jump-check H\n[video-embedded#](/api/files/${fid}.mp4)` });
const H = held.body?.id;
const plain = [];
for (let i = 1; i <= 60; i++) plain.push((await api('/api/admin/new', { type: 'md', text: `jump-check plain ${i}` })).body?.id);
const MID = plain[plain.length - 1];
let approved = 0;
for (let i = 0; i < 90 && approved !== 200; i++) {
  await fetch(`${BASE}/api/files/${fid}.mp4?view=public`, { headers: { cookie } });
  approved = (await fetch(`${BASE}/api/admin/files/${fid}/approve`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' })).status;
  if (approved !== 200) await sleep(2000);
}
check('the held message was posted and its video approved (released)', !!H && approved === 200, `H=${H} approve=${approved}`);
const top = (await api('/api/messages?offset=0&limit=3&direction=desc')).body.map((m) => m.id);
check('the released message is the newest by time while its id is the lowest of the batch', top[0] === H, `top=${top}`);

// ---- a reader window (no login), a link to the newest message, then an in-page jump to the released one
const profile = mkdtempSync(join(tmpdir(), 'jump-check-'));
const port = 9889;
const proc = spawn(chromePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--lang=he', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 50; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); if (target) break; } catch {} await sleep(200); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let mid = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++mid; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const go = async (url, wait = 3500) => { await send('Page.navigate', { url }); await sleep(wait); };
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
const ids = () => ev(`[...document.querySelectorAll('app-message')].map(e => Number(e.id)).filter(Boolean)`);
const visible = (m) => ev(`(() => { const e = document.getElementById('${m}'); if (!e) return false; const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; })()`);

await go(`${BASE}/#${MID}`);
check('a link to the newest message opens its window', await visible(MID));
await ev(`location.hash = '#${H}'`); await sleep(3000);
check('an in-page jump to the released message loads it and shows it', await visible(H));
let all = await ids();
check('no duplicate messages after the jump', all.length === new Set(all).size, `count=${all.length}`);
await send('Page.navigate', { url: 'about:blank' }); await sleep(500);
await go(`${BASE}/#${H}`);
check('a fresh link to the released message shows it', await visible(H));

ws.close(); proc.kill();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
