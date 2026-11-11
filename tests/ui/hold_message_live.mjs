// Live check of the hidden message of held videos, in three real Chrome windows (CDP, no extra packages) that are opened once and never
// refreshed: the approver (the owner), a reader, and a Writer who has no right to approve. Needs the local stack started with the flag ON:
//   docker compose -f docker-compose.local.yml -f tests/docker-compose.hold-test.yml up -d --no-deps backend
//   node tests/ui/hold_message_live.mjs [chromePath]
// Posts a message with a text and two held videos, then:
//   1. the approver gets it live (labeled); the reader and the Writer get nothing: not on the page, not in the API, not in the raw live stream;
//   2. one video approved: still hidden from the reader and the Writer, still labeled for the approver;
//   3. the second approved: it appears at once in all three windows, once, at the newest place; the approver's label goes away.
// Also asks as a manager 1 (moderator) and a manager 2 (reviewer) without Writer: they are approvers, so they get the held message.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localBase } from './guard.mjs';

const chromePath = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = localBase(process.env.BASE_URL);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

async function launch(email, port) {
  const profile = mkdtempSync(join(tmpdir(), 'hold-live-'));
  const proc = spawn(chromePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run',
    '--window-size=1100,1500', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {}
    await sleep(200);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  const goto = async (url, wait = 3000) => { await send('Page.navigate', { url }); await sleep(wait); };
  await send('Page.enable'); await send('Runtime.enable');
  await goto(`${BASE}/auth/dev-login${email ? '?email=' + encodeURIComponent(email) : ''}`, 1200);
  return { ev, goto, close: () => { ws.close(); proc.kill(); } };
}

// a plain API session (no browser) for the permission questions, and a raw live-stream listener
async function apiSession(email) {
  const r = await fetch(`${BASE}/auth/dev-login?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const api = async (path, opts = {}) => fetch(BASE + path, { ...opts, headers: { cookie, ...(opts.headers || {}) } });
  api.listen = async () => { // everything the server sends on /api/events to this account
    const ac = new AbortController(); const got = { text: '' };
    const res = await fetch(BASE + '/api/events', { headers: { cookie }, signal: ac.signal });
    (async () => { try { for await (const chunk of res.body) got.text += Buffer.from(chunk).toString('utf8'); } catch {} })();
    return { got, stop: () => ac.abort() };
  };
  return api;
}

const tag = randomBytes(4).toString('hex');
const emails = { writer: `writer-only-${tag}@example.com`, reader: `rdr${tag}@example.com`, rev: `rev-only-${tag}@example.com`, mod: `mod-only-${tag}@example.com` };
const owner = await launch(null, 9341);
const call = (b, path, body) => b.ev(`fetch(${JSON.stringify(path)}, ${body === undefined ? '{}' : `{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}`}).then(async r => ({status: r.status, body: await r.text()}))`);
const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };

const mp4 = readFileSync(join(ROOT, 'tests', 'media', 'short.mp4'));
async function uploadVideo() {
  const b64 = Buffer.concat([mp4, randomBytes(16)]).toString('base64');
  const r = await owner.ev(`(async () => { const bin = atob(${JSON.stringify(b64)}); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    const f = new FormData(); f.append('file', new Blob([a], {type: 'video/mp4'}), 'live-${tag}.mp4');
    const r = await fetch('/api/admin/upload', {method: 'POST', body: f}); return r.json(); })()`);
  return r.url.split('?')[0].split('/').pop().split('.')[0];
}
async function waitChecked(fid) {
  for (let i = 0; i < 150; i++) {
    const s = json(await call(owner, `/api/files/${fid}/moderation`));
    if (s && s.status !== 'pending') return s.status;
    await sleep(2000);
  }
  return 'pending';
}
async function approve(fid) {
  await call(owner, `/api/files/${fid}.mp4?view=public`); // the approver has to look at it the way readers get it
  return (await call(owner, `/api/admin/files/${fid}/approve`, {})).status;
}

// the new / edit message events in a raw live stream (file-moderation events carry file ids to everyone on purpose and no text)
const messageEvents = (raw) => raw.split('\n\n').map(c => c.replace(/^data: /, '')).map(c => { try { return JSON.parse(c); } catch { return null; } })
  .filter(e => e && (e.type === 'new-message' || e.type === 'edit-message'));
const domCount = (b, id) => b.ev(`document.querySelectorAll('[id="${id}"]').length`);
const bodyHas = (b, s) => b.ev(`document.body.innerText.includes(${JSON.stringify(s)})`);
const elText = (b, id) => b.ev(`(document.getElementById('${id}') || {}).innerText || ''`);
const domOrder = (b) => b.ev(`[...document.querySelectorAll('[id]')].map(e => e.id).filter(x => /^[0-9]+$/.test(x)).map(Number)`);

let users0 = null, msgId = null, plainId = null, listeners = [];
const wins = {};
try {
  users0 = json(await call(owner, '/api/admin/privilegs-users/get-list')) || [];
  await call(owner, '/api/admin/privilegs-users/set', { list: [...users0,
    { email: emails.writer, username: '', publicName: '', privileges: { writer: true } },
    { email: emails.rev, username: '', publicName: '', privileges: { reviewer: true } },
    { email: emails.mod, username: '', publicName: '', privileges: { moderator: true } }] });

  // three windows, opened on the channel once; none of them is refreshed again
  wins.writer = await launch(emails.writer, 9342);
  wins.reader = await launch(emails.reader, 9343);
  await owner.goto(`${BASE}/`, 3500); await wins.writer.goto(`${BASE}/`, 3500); await wins.reader.goto(`${BASE}/`, 3500);
  const { writer, reader } = wins;
  const wapi = await apiSession(emails.writer), rapi = await apiSession(emails.reader);
  const wl = await wapi.listen(), rl = await rapi.listen(); listeners = [wl, rl];

  const v1 = await uploadVideo(), v2 = await uploadVideo();
  check('both videos finished the automatic check', ['regional', 'open', 'blurred'].includes(await waitChecked(v1)) && ['regional', 'open', 'blurred'].includes(await waitChecked(v2)));

  // ---- 1. a message with a text and two held videos
  const text = `held-msg-${tag} טקסט ההודעה\n[video-embedded#](/api/files/${v1}.mp4)\n[video-embedded#](/api/files/${v2}.mp4)`;
  const posted = json(await call(owner, '/api/admin/new', { type: 'md', text }));
  msgId = posted?.id;
  check('the message was posted', !!msgId);
  const plain = json(await call(owner, '/api/admin/new', { type: 'md', text: `plain-${tag} הודעה רגילה אחריה` }));
  plainId = plain?.id;
  await sleep(4000);

  const label = await elText(owner, msgId);
  check('approver (no refresh): the held message appeared live, with its text and the label', label.includes(`held-msg-${tag}`) && label.includes('מוסתרת מהקוראים'), label.slice(0, 100));
  for (const [who, b, api, l] of [['reader', reader, rapi, rl], ['Writer without the right to approve', writer, wapi, wl]]) {
    check(`${who} (no refresh): the plain message arrived live`, await bodyHas(b, `plain-${tag}`));
    check(`${who}: the held message is NOT on the page (text and videos)`, !(await bodyHas(b, `held-msg-${tag}`)) && (await domCount(b, msgId)) === 0);
    const list = await (await api('/api/messages?limit=30')).json();
    check(`${who}: not in the list API, its own page is a 404`, !list.some(m => m.id === msgId) && (await api(`/api/messages/${msgId}`)).status === 404);
    check(`${who}: the raw live stream carried the plain message but no message event of the held one`, l.got.text.includes(`plain-${tag}`) && !l.got.text.includes(`held-msg-${tag}`) && !messageEvents(l.got.text).some(e => JSON.stringify(e).includes(v1) || JSON.stringify(e).includes(v2)));
  }

  // manager 1 / manager 2 without Writer are approvers
  for (const [who, email] of [['manager 1 (moderator, no Writer)', emails.mod], ['manager 2 (reviewer, no Writer)', emails.rev]]) {
    const s = await apiSession(email);
    const one = (await s(`/api/messages/${msgId}`)).status;
    const inList = (await (await s('/api/messages?limit=30')).json()).some(m => m.id === msgId);
    check(`${who}: reads the held message (the approval right decides)`, one === 200 && inList, `page ${one}, list ${inList}`);
  }

  // ---- 2. one video approved: still hidden
  check('approve video 1', (await approve(v1)) === 200);
  await sleep(4000);
  for (const [who, b, api] of [['reader', reader, rapi], ['Writer without the right to approve', writer, wapi]]) {
    check(`${who}: after ONE of two approvals the whole message is still hidden`, !(await bodyHas(b, `held-msg-${tag}`)) && (await domCount(b, msgId)) === 0 && !((await (await api('/api/messages?limit=30')).json()).some(m => m.id === msgId)));
  }
  check('approver: still labeled as hidden, once', (await elText(owner, msgId)).includes('מוסתרת מהקוראים') && (await domCount(owner, msgId)) === 1);

  // ---- 3. the second approved: it appears at once in every window
  check('approve video 2', (await approve(v2)) === 200);
  for (const [who, b] of [['reader', reader], ['Writer without the right to approve', writer], ['approver', owner]]) {
    let appeared = false;
    for (let i = 0; i < 24 && !appeared; i++) { appeared = (await domCount(b, msgId)) > 0 && !(await elText(b, msgId)).includes('מוסתרת מהקוראים'); if (!appeared) await sleep(500); }
    check(`${who}: the message is on the page by itself, without a refresh`, appeared);
  }
  await sleep(1500);
  for (const [who, b] of [['reader', reader], ['Writer without the right to approve', writer], ['approver', owner]]) {
    check(`${who}: exactly once, the text once`, (await domCount(b, msgId)) === 1 && (await b.ev(`document.body.innerText.split('held-msg-${tag}').length - 1`)) === 1);
    const order = await domOrder(b);
    const others = order.filter(x => x !== msgId && x !== plainId);
    const asc = others.length > 1 && others[0] < others[others.length - 1]; // the direction of this window's list: oldest first?
    const posMsg = order.indexOf(msgId), posPlain = order.indexOf(plainId);
    check(`${who}: at the newest place, after the plain message that was posted later`, asc ? posMsg > posPlain : posMsg < posPlain, JSON.stringify(order.slice(0, 6)));
  }
  check('approver: the label is gone', !(await elText(owner, msgId)).includes('מוסתרת מהקוראים'));
  check('the raw stream of the reader and the Writer got the release (the text now)', rl.got.text.includes(`held-msg-${tag}`) && wl.got.text.includes(`held-msg-${tag}`));
} finally {
  for (const l of listeners) l.stop();
  for (const id of [msgId, plainId]) if (id) await call(owner, `/api/admin/delete-message/${id}`);
  if (users0) await call(owner, '/api/admin/privilegs-users/set', { list: users0 });
  owner.close(); Object.values(wins).forEach(w => w.close());
}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nFAILED');
process.exit(results.every(Boolean) ? 0 : 1);
