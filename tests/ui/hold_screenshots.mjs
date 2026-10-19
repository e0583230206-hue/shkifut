// Screenshots of the "video waits for approval" flow in a real Chrome (CDP, no extra packages). Needs the local stack started with
// tests/docker-compose.hold-test.yml (flag ON). Usage:
//   node tests/ui/hold_screenshots.mjs <fileId> <outDir> [chromePath]
// The file must be a held video that finished its check. Posts a message with it, then takes:
//   1-reader.png        what a reader sees (waiting for approval)
//   2-approver-bar.png  the moderator bar with the "waiting for approval" badge
//   3-grid-blocked.png  the grid before "show as readers see": the approve button is off, with the hint
//   4-as-readers.png    after "show as readers see"
//   5-grid-ready.png    the grid after the preview: the approve button is on
//   6-approved.png      after the approval (badge + reader view)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [fileId, outDir, chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'] = process.argv.slice(2);
if (!fileId || !outDir) { console.error('usage: hold_screenshots.mjs <fileId> <outDir> [chrome]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

async function launch(email, port) {
  const profile = mkdtempSync(join(tmpdir(), 'hold-shot-'));
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
  const goto = async (url, wait = 2500) => { await send('Page.navigate', { url }); await sleep(wait); };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64'));
    console.log('saved', name);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await goto(`${BASE}/auth/dev-login${email ? '?email=' + encodeURIComponent(email) : ''}`, 1200);
  return { send, ev, goto, shot, close: () => { ws.close(); proc.kill(); } };
}

const clickText = (text) => `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(text)}) && !x.disabled); if (b) { b.click(); return true; } return false; })()`;

// a message that embeds the video, posted by the owner through the API
const owner = await launch(null, 9331);
const msgId = await owner.ev(`fetch('/api/admin/new', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ type: 'md', text: 'סרטון לבדיקה\\n[video-embedded#](/api/files/${fileId}.mp4)' }) }).then(r => r.json()).then(j => j.id)`);
console.log('message', msgId);
try {
  // 1. a reader
  const reader = await launch(`reader-shot@example.com`, 9332);
  await reader.goto(`${BASE}/#${msgId}`, 3500);
  const held = await reader.ev(`(() => { const w = [...document.querySelectorAll('.mod-wrap')].filter(x => x.dataset.fileId === '${fileId}')[0]; return w ? { hidden: !!w.querySelector('.mod-hidden'), text: w.querySelector('.mod-hidden')?.textContent, video: !!w.querySelector('video') } : null; })()`);
  check('reader sees "ממתין לאישור" in place of the video, and no video element', !!held && held.hidden && held.text === 'ממתין לאישור' && !held.video, JSON.stringify(held));
  await reader.ev(`document.querySelector('.mod-hidden')?.scrollIntoView({block:'center'})`);
  await reader.shot('1-reader.png');
  reader.close();

  // 2. the approver (owner) sees the bar
  await owner.goto(`${BASE}/#${msgId}`, 3500);
  check('moderator bar shows the "waiting for approval" badge', (await owner.ev(`document.body.innerText`)).includes('ממתין לאישור פרסום'));
  await owner.ev(`document.querySelector('.mod-wrap')?.scrollIntoView({block:'center'})`);
  await owner.shot('2-approver-bar.png');

  // 3. the grid before the preview: the approve button is off
  await owner.ev(clickText('בדיקת דמויות')); await sleep(2500);
  const state3 = await owner.ev(`(() => { const b = document.querySelector('.approve-publish'); return b ? { disabled: b.disabled, hint: document.querySelector('.hold-hint')?.textContent } : null; })()`);
  check('grid: "אשר פרסום" exists and is disabled before the preview', !!state3 && state3.disabled === true, JSON.stringify(state3));
  check('grid: the hint tells what to do', !!state3 && (state3.hint || '').includes('הצג כמו הקוראים'), JSON.stringify(state3));
  await owner.shot('3-grid-blocked.png');
  await owner.ev(`document.querySelector('.review-card nb-card-footer button')?.click()`); await sleep(1000);
  check('the grid closed', (await owner.ev(`document.querySelectorAll('.review-card').length`)) === 0);

  // 4. "show as readers see"
  await owner.ev(clickText('הצג כמו הקוראים')); await sleep(2500);
  await owner.ev(`document.querySelector('.mod-wrap')?.scrollIntoView({block:'center'})`);
  await owner.shot('4-as-readers.png');

  // 5. the grid after the preview: the button is on
  await owner.ev(clickText('בדיקת דמויות')); await sleep(2500);
  const state5 = await owner.ev(`(() => { const b = document.querySelector('.approve-publish'); return b ? { disabled: b.disabled, hint: document.querySelector('.hold-hint')?.textContent } : null; })()`);
  check('grid: "אשר פרסום" is enabled after the preview', !!state5 && state5.disabled === false, JSON.stringify(state5));
  await owner.shot('5-grid-ready.png');

  // 6. approve
  await owner.ev(`document.querySelector('.approve-publish')?.click()`); await sleep(2500);
  await owner.goto(`${BASE}/#${msgId}`, 3500);
  check('after the approval the bar says "אושר לפרסום"', (await owner.ev(`document.body.innerText`)).includes('אושר לפרסום'));
  await owner.ev(`document.querySelector('.mod-wrap')?.scrollIntoView({block:'center'})`);
  await owner.shot('6-approved.png');
  const reader2 = await launch(`reader-shot2@example.com`, 9333);
  await reader2.goto(`${BASE}/#${msgId}`, 3500);
  check('a reader now gets the video', await reader2.ev(`!!document.querySelector('video, .mod-media')`));
  await reader2.shot('7-reader-after.png');
  reader2.close();
} finally {
  if (msgId) await owner.ev(`fetch('/api/admin/delete-message/${msgId}')`);
  owner.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
