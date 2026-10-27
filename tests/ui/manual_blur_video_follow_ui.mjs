// The follow-the-mouse recording of the manual video blur editor in a real Chrome (CDP): draw a box, hold the left button on it, press Space (the video plays),
// change the boxes there (keyframes), the end second, undo / redo, the preview, save (the render runs on the server: the progress is shown), the result
// in the bar, reopen, the unsaved-changes question, remove, dark theme and a phone with a finger. LOCAL stack only: the backend with MANUAL_BLUR_VIDEO=1 and
// the real moderation service (tests/docker-compose.manual-blur-render.yml, project tc-mb) and the page built with `ng build --configuration development`.
// Needs ffmpeg on the host (it makes the test video).
//   node tests/ui/manual_blur_video_ui.mjs <outDir> http://localhost:18084
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir, base] = process.argv.slice(2);
if (!outDir || !/^http:\/\/localhost:\d+$/.test(base || '') || /:(8080|8081)$/.test(base)) { console.error('usage: manual_blur_video_ui.mjs <outDir> <local url, e.g. http://localhost:18084>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

// ---- the test video: 40 s, 1280x720, full of detail, with sound ----
const work = mkdtempSync(join(tmpdir(), 'mbv-'));
const videoPath = join(work, 'detail.mp4');
const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath]);
if (ff.status !== 0) { console.error('ffmpeg is needed to make the test video:', String(ff.stderr).slice(0, 200)); process.exit(2); }

// ---- setup through the API (node has its own cookie) ----
let cookie = '';
const api = async (path, opt = {}) => {
  const r = await fetch(base + path, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r;
};
const post = (path, obj) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
await api('/auth/dev-login');
const fd = new FormData();
fd.append('file', new Blob([Buffer.concat([readFileSync(videoPath), Buffer.from(String(Math.random()))])], { type: 'video/mp4' }), 'detail.mp4');
const up = await (await api('/api/admin/upload', { method: 'POST', body: fd })).json();
const vid = up.url.match(/\/api\/files\/([0-9a-f]{40})/)[1];
for (let i = 0; i < 300; i++) {   // the automatic check
  const info = await (await api(`/api/files/${vid}/moderation`)).json();
  if (info.status !== 'pending' && info.autoDecision) { console.log(`     automatic result: ${info.status} (${info.autoDecision})`); if (info.status !== 'open') await post('/api/admin/files/moderation', { id: vid, status: 'open' }); break; }
  await sleep(2000);
}
await post('/api/admin/new', { type: 'md', text: `עריכת וידאו ידנית\n[video-embedded#](${up.url})` });
const originalSize = (await (await api(`/api/files/${vid}`)).arrayBuffer()).byteLength;

// ---- Chrome ----
const profile = mkdtempSync(join(tmpdir(), 'mbvui-'));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9409', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9409/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('  js error:', r.result.exceptionDetails.exception?.description?.slice(0, 200)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(120); } return false; };
const key = async (k, mods = 0, code) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: code ?? k, modifiers: mods, text: k === ' ' ? ' ' : undefined, windowsVirtualKeyCode: { Delete: 46, ArrowRight: 39, ArrowLeft: 37, z: 90, y: 89, ' ': 32 }[k] ?? 0 }); await sleep(250); };
const rectOf = (sel) => ev(`JSON.stringify((() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })())`).then(JSON.parse);
const at = (r, fx, fy) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy });
const mouse = (type, p, buttons = 1) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1 });
const dragMouse = async (a, b, steps = 6) => { await mouse('mouseMoved', a, 0); await mouse('mousePressed', a); for (let i = 1; i <= steps; i++) await mouse('mouseMoved', { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }); await mouse('mouseReleased', b); await sleep(200); };
const dragTouch = async (a, b, steps = 6) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
  for (let i = 1; i <= steps; i++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250);
};
const curTime = async () => { const s = await ev(`document.querySelector('app-manual-blur-video .transport .time').textContent`); const m = s.match(/(\d+):(\d+\.\d)/); return m ? +m[1] * 60 + +m[2] : -1; };
const seekTo = async (sec) => {   // a click on the timeline
  const r = await rectOf('app-manual-blur-video .timeline');
  const dur = await ev(`document.querySelector('app-manual-blur-video video').duration`);
  const p = at(r, sec / dur, 0.1);
  await mouse('mouseMoved', p, 0); await mouse('mousePressed', p); await mouse('mouseReleased', p);
  await waitFor(`Math.abs(document.querySelector('app-manual-blur-video video').currentTime - ${sec}) < 0.15`, 5000); await sleep(250);
};
const nTracks = () => ev(`document.querySelectorAll('app-manual-blur-video .timeline .row').length`);
const nKeys = (row = 0) => ev(`document.querySelectorAll('app-manual-blur-video .timeline .row')[${row}]?.querySelectorAll('.kf').length ?? -1`);
const boxStyle = (i = 0) => ev(`JSON.stringify((() => { const e = document.querySelectorAll('app-manual-blur-video .stage .shape:not(.draft)')[${i}]; return e ? { l: parseFloat(e.style.left), t: parseFloat(e.style.top), w: parseFloat(e.style.width), h: parseFloat(e.style.height) } : null; })())`).then(JSON.parse);
const clickText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
const openEditor = async () => {
  await ev(`(() => { const w = document.querySelector('.mod-wrap[data-file-id="${vid}"]'); w.scrollIntoView({ block: 'center' }); w.querySelector('.mod-btn-manual').click(); })()`);
  return waitFor(`(() => { const v = document.querySelector('app-manual-blur-video video'); return !!v && v.readyState >= 1 && v.duration > 1; })()`, 30000);
};
const loadPage = async () => { await send('Page.navigate', { url: base + '/' }); await waitFor(`!!document.querySelector('.mod-wrap[data-file-id="${vid}"] .mod-bar')`, 30000); await sleep(500); };

const keyframeTimes = () => ev(`JSON.stringify([...document.querySelectorAll('app-manual-blur-video .timeline .row')[0].querySelectorAll('.kf')].map(k => parseFloat(k.style.left)))`).then(JSON.parse);

try {
  await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/auth/dev-login' }); await sleep(1500);
  await loadPage();
  check('the editor opens', await openEditor());
  check('the hint about following is shown', (await ev(`document.querySelector('app-manual-blur-video').textContent`)).includes('לעקוב אחרי משהו שזז'));
  check('speed buttons 0.25 / 0.5 / 1', (await ev(`[...document.querySelectorAll('app-manual-blur-video .transport .tool')].map(b => b.textContent.trim()).join(' ')`)).includes('0.25× 0.5× 1×'));

  await seekTo(5);
  let r = await rectOf('app-manual-blur-video .stage');
  await dragMouse(at(r, 0.1, 0.2), at(r, 0.3, 0.45));
  check('a box drawn at 5 s', (await nTracks()) === 1 && (await nKeys()) === 1);
  await clickText('app-manual-blur-video .tool', 'בחירה');
  await ev(`document.querySelector('app-manual-blur-video video').playbackRate`);
  await clickText('app-manual-blur-video .transport .tool', '0.5×');
  check('the speed is 0.5', (await ev(`document.querySelector('app-manual-blur-video video').playbackRate`)) === 0.5);

  // hold on the box (at its middle), press Space, move the mouse to the right while the video plays
  r = await rectOf('app-manual-blur-video .stage');
  const start = at(r, 0.2, 0.325);
  await mouse('mouseMoved', start, 0); await mouse('mousePressed', start);
  await key(' ');
  check('Space while the button is held plays the video', await waitFor(`!document.querySelector('app-manual-blur-video video').paused`, 3000));
  check('"recording" is shown', await ev(`!!document.querySelector('app-manual-blur-video .rec')`));
  const t0 = await ev(`document.querySelector('app-manual-blur-video video').currentTime`);
  for (let i = 1; i <= 24; i++) { await mouse('mouseMoved', { x: start.x + r.w * 0.4 * i / 24, y: start.y + r.h * 0.25 * Math.sin(i / 24 * Math.PI) }); await sleep(100); }
  const tNow = await ev(`document.querySelector('app-manual-blur-video video').currentTime`);
  await mouse('mouseReleased', { x: start.x + r.w * 0.4, y: start.y });
  await sleep(500);
  check('letting go of the button stops the video', await ev(`document.querySelector('app-manual-blur-video video').paused`));
  check('the recording indicator is gone', !(await ev(`!!document.querySelector('app-manual-blur-video .rec')`)));
  const kn = await nKeys();
  check('the pass made keyframes (more than 3, fewer than 40)', kn > 3 && kn < 40, kn);
  const ks = await keyframeTimes();
  check('the keyframes lie between where it started and where it stopped', Math.min(...ks.slice(1)) >= t0 / 40 * 100 - 3 && Math.max(...ks) <= (tNow + 1) / 40 * 100 + 3, `${ks} t0=${t0} now=${tNow}`);
  await seekTo(5 + (tNow - t0) * 0.5);
  const bm = await boxStyle(0);
  await seekTo(Math.min(39, tNow + 1.5));
  const be = await boxStyle(0);
  check('the box moved to the right along the recorded pass', be && bm && be.l > bm.l + 3 && be.l > 25, `${JSON.stringify(bm)} ${JSON.stringify(be)}`);
  await shot('f1-recorded.png');

  // undo takes the whole recording back in one step
  await key('z', 2, 'KeyZ');
  check('Ctrl+Z takes the whole recording back (one keyframe again)', (await nKeys()) === 1, await nKeys());

  // ---- the brush: a round blur under the mouse, + / - change its size, it follows the mouse while the video plays ----
  await seekTo(10);
  await clickText('app-manual-blur-video .tool', 'מברשת');
  r = await rectOf('app-manual-blur-video .stage');
  await mouse('mouseMoved', at(r, 0.7, 0.6), 0); await sleep(150);
  check('brush: a ring shows the size under the mouse', await ev(`!!document.querySelector('app-manual-blur-video .stage .ring')`));
  const ringW = await ev(`document.querySelector('app-manual-blur-video .stage .ring').getBoundingClientRect().width`);
  const ringH = await ev(`document.querySelector('app-manual-blur-video .stage .ring').getBoundingClientRect().height`);
  check('the ring is round (same width and height in pixels)', Math.abs(ringW - ringH) < 2, `${ringW} x ${ringH}`);
  await mouse('mousePressed', at(r, 0.7, 0.6)); await mouse('mouseReleased', at(r, 0.7, 0.6)); await sleep(250);
  check('a click makes a round blur (a second track, one keyframe)', (await nTracks()) === 2 && (await nKeys(1)) === 1, `${await nTracks()} ${await nKeys(1)}`);
  const bi = async () => { const i = (await ev(`document.querySelectorAll('app-manual-blur-video .stage .shape:not(.draft)').length`)) - 1; return { b: await boxStyle(i), i }; };
  const px = (b) => ({ w: b.w / 100 * r.w, h: b.h / 100 * r.h, cx: (b.l + b.w / 2) / 100 * r.w, cy: (b.t + b.h / 2) / 100 * r.h });
  let c0 = px((await bi()).b);
  check('it is a circle in pixels, centred on the click', Math.abs(c0.w - c0.h) < 3 && Math.abs(c0.cx - r.w * 0.7) < 4 && Math.abs(c0.cy - r.h * 0.6) < 4, JSON.stringify(c0));
  await key('+');
  let c1 = px((await bi()).b);
  check('"+" makes it bigger (and still round, same centre)', c1.w > c0.w * 1.1 && Math.abs(c1.w - c1.h) < 3 && Math.abs(c1.cx - c0.cx) < 3, `${c0.w} -> ${c1.w}`);
  check('the size change is a keyframe at this second (still one: same second)', (await nKeys(1)) === 1, await nKeys(1));
  await key('-'); await key('-');
  let c2 = px((await bi()).b);
  check('"-" makes it smaller', c2.w < c1.w * 0.9, `${c1.w} -> ${c2.w}`);
  await key('z', 2, 'KeyZ'); await key('z', 2, 'KeyZ'); await key('z', 2, 'KeyZ');

  // hold, Space, move: it follows; "+" while recording makes the next part bigger
  await seekTo(12);
  const tracksBefore = await nTracks();
  r = await rectOf('app-manual-blur-video .stage');
  const s0 = at(r, 0.2, 0.7);
  await mouse('mouseMoved', s0, 0); await mouse('mousePressed', s0);
  await key(' ');
  check('brush: Space while the button is held plays and records', await waitFor(`!document.querySelector('app-manual-blur-video video').paused && !!document.querySelector('app-manual-blur-video .rec')`, 3000));
  for (let i = 1; i <= 16; i++) { await mouse('mouseMoved', { x: s0.x + r.w * 0.5 * i / 16, y: s0.y - r.h * 0.2 * i / 16 }); await sleep(100); if (i === 8) await key('+'); }
  await mouse('mouseReleased', { x: s0.x + r.w * 0.5, y: s0.y - r.h * 0.2 }); await sleep(500);
  const nk = await nKeys(tracksBefore);
  check('the brush recorded a path (keyframes)', (await nTracks()) === tracksBefore + 1 && nk >= 3 && nk < 40, `${await nTracks()} ${nk}`);
  const tEnd = await ev(`document.querySelector('app-manual-blur-video video').currentTime`);
  await seekTo(12.2);
  const early = px((await bi()).b);
  await seekTo(Math.min(39, tEnd + 0.5));
  const late = px((await bi()).b);
  check('it moved right and up with the mouse', late.cx > early.cx + r.w * 0.2 && late.cy < early.cy - r.h * 0.05, `${JSON.stringify(early)} ${JSON.stringify(late)}`);
  check('"+" during the recording made it bigger later on, and it is still round', late.w > early.w * 1.1 && Math.abs(late.w - late.h) < 4, `${early.w} -> ${late.w} (${late.h})`);
  await shot('f2-brush.png');

  // plus / minus on a rectangle too
  await clickText('app-manual-blur-video .tool', 'בחירה');
  await seekTo(8);
  r = await rectOf('app-manual-blur-video .stage');
  const rb0 = await boxStyle(0);
  await mouse('mouseMoved', at(r, (rb0.l + rb0.w / 2) / 100, (rb0.t + rb0.h / 2) / 100), 0); await mouse('mousePressed', at(r, (rb0.l + rb0.w / 2) / 100, (rb0.t + rb0.h / 2) / 100)); await mouse('mouseReleased', at(r, (rb0.l + rb0.w / 2) / 100, (rb0.t + rb0.h / 2) / 100)); await sleep(200);
  await key('+');
  const rb1 = await boxStyle(0);
  check('a rectangle: "+" makes it bigger, same shape', rb1 && rb1.w > rb0.w * 1.1 && Math.abs(rb1.w / rb1.h - rb0.w / rb0.h) < 0.05, `${JSON.stringify(rb0)} ${JSON.stringify(rb1)}`);
} catch (e) { console.log('ERROR', e); results.push(false); }
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME CHECKS FAILED');
process.exit(0);
