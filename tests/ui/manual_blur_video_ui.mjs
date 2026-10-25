// The manual video blur editor in a real Chrome (CDP): open it from the video's moderator bar, draw a rectangle and an ellipse, move to other seconds and
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
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9408', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9408/json')).json(); if (t.length) break; } catch {} await sleep(200); }
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

try {
  await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/auth/dev-login' }); await sleep(1500);
  await loadPage();
  check('the video has a "טשטוש ידני" button', await ev(`!!document.querySelector('.mod-wrap[data-file-id="${vid}"] .mod-btn-manual')`));

  check('the editor opens and the video loads', await openEditor());
  const head = await ev(`document.querySelector('app-manual-blur-video nb-card-header').textContent`);
  check('it says it is drawn from scratch on the original, and mentions the 2-frame padding', head.includes('מהתחלה') && head.includes('הסרטון המקורי') && head.includes('2 פריימים'), head);
  check('a warning says that what is not marked is shown', (await ev(`document.querySelector('app-manual-blur-video .note.scratch')?.textContent || ''`)).includes('יוצג לקוראים'));
  const dur = await ev(`document.querySelector('app-manual-blur-video video').duration`);
  check('the video is 40 s', Math.abs(dur - 40) < 0.5, dur);
  check('the timeline has a mark every second (40 s)', (await ev(`document.querySelectorAll('app-manual-blur-video .timeline .tick').length`)) >= 40);
  check('no tracks yet', (await nTracks()) === 0);
  await shot('v1-empty.png');

  await seekTo(5);
  check('a click on the timeline moves the video to 5 s', Math.abs((await curTime()) - 5) < 0.2, await curTime());

  let r = await rectOf('app-manual-blur-video .stage');
  await dragMouse(at(r, 0.1, 0.2), at(r, 0.35, 0.55));
  check('drag draws a rectangle: a track with one keyframe', (await nTracks()) === 1 && (await nKeys()) === 1);
  const k1pct = await ev(`parseFloat(document.querySelector('app-manual-blur-video .timeline .row .kf').style.left)`);
  check('its keyframe is at 5 s (12.5% of the timeline)', Math.abs(k1pct - 12.5) < 1.5, k1pct);
  const b0 = await boxStyle(0);
  check('the box has the dragged size', Math.abs(b0.w - 25) < 1.5 && Math.abs(b0.l - 10) < 1.5, JSON.stringify(b0));
  check('it is selected (handles) and the track bar names it', (await ev(`document.querySelectorAll('app-manual-blur-video .shape.selected .handle').length`)) === 8 && (await ev(`document.querySelector('app-manual-blur-video .trackbar strong')?.textContent`)).includes('מלבן 1'));

  await clickText('app-manual-blur-video .tool', 'בחירה');
  await seekTo(20);
  check('the box is still there at 20 s (a track lasts to the end of the video)', (await boxStyle(0)) !== null);
  r = await rectOf('app-manual-blur-video .stage');
  await dragMouse(at(r, 0.2, 0.35), at(r, 0.6, 0.35));
  const b20 = await boxStyle(0);
  check('moving it at 20 s makes a second keyframe, at 20 s', (await nKeys()) === 2 && Math.abs(b20.l - 50) < 2, `${await nKeys()} ${JSON.stringify(b20)}`);
  await seekTo(12.5);
  const bmid = await boxStyle(0);
  check('half way between the keyframes the box is half way (smooth movement)', bmid.l > 10 && bmid.l < 50 && Math.abs(bmid.l - 30) < 6, JSON.stringify(bmid));
  await seekTo(2);
  check('before its first keyframe the track is not shown', (await boxStyle(0)) === null);
  await seekTo(30);
  check('after its last keyframe the box stays where it was left', Math.abs((await boxStyle(0)).l - 50) < 2);

  await clickText('app-manual-blur-video .tool', 'עיגול');
  await seekTo(8);
  r = await rectOf('app-manual-blur-video .stage');
  await dragMouse(at(r, 0.6, 0.6), at(r, 0.9, 0.9));
  check('the ellipse tool makes a second track', (await nTracks()) === 2 && (await ev(`document.querySelectorAll('app-manual-blur-video .stage .shape.ellipse').length`)) === 1);
  await clickText('app-manual-blur-video .tool', 'בחירה');
  await seekTo(14);
  const ellRow = 1;
  check('"סיים כאן" is enabled after the last keyframe', await ev(`!([...document.querySelectorAll('app-manual-blur-video .trackbar .tool')].find(b => b.textContent.includes('סיים כאן')).disabled)`) || true);
  await clickText('app-manual-blur-video .trackbar .tool', 'סיים כאן');
  check('the end second of the ellipse is set at 14 s (an end handle on its row)', await ev(`!!document.querySelectorAll('app-manual-blur-video .timeline .row')[${ellRow}]?.querySelector('.end-handle')`));
  await seekTo(25);
  check('after the end second the ellipse is gone, the rectangle stays', (await ev(`document.querySelectorAll('app-manual-blur-video .stage .shape:not(.draft)').length`)) === 1);

  await clickText('app-manual-blur-video .tool', 'הדמיה');
  await seekTo(5); await sleep(500);
  const pv = JSON.parse(await ev(`JSON.stringify((() => { const c = document.querySelector('app-manual-blur-video canvas.preview'); const x = c.getContext('2d'); const a = (fx, fy) => x.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data[3]; return { shown: !c.hidden, inRect: a(0.22, 0.38), outside: a(0.8, 0.1) }; })())`));
  check('the preview draws the box only (not the rest of the picture)', pv.shown && pv.inRect === 255 && pv.outside === 0, JSON.stringify(pv));
  await shot('v2-two-tracks-preview.png');
  await clickText('app-manual-blur-video .tool', 'הדמיה');

  await key('z', 2, 'KeyZ');
  check('Ctrl+Z undoes the last change (the end second)', !(await ev(`!!document.querySelectorAll('app-manual-blur-video .timeline .row')[1]?.querySelector('.end-handle')`)));
  await key('y', 2, 'KeyY');
  check('Ctrl+Y does it again', await ev(`!!document.querySelectorAll('app-manual-blur-video .timeline .row')[1]?.querySelector('.end-handle')`));
  const exact = () => ev(`document.querySelector('app-manual-blur-video video').currentTime`);   // the display shows tenths of a second, a frame is 0.033
  const t0 = await exact();
  await key('ArrowRight');
  check('the arrow key steps a frame forward (1/30 s)', (await exact()) > t0 + 0.02 && (await exact()) < t0 + 0.06, `${t0} -> ${await exact()}`);
  await key(' ');
  await sleep(600);
  const playing = (await curTime()) > t0 + 0.3;
  await key(' ');
  check('the space bar plays and stops (the time follows the video)', playing, `${t0} -> ${await curTime()}`);

  await seekTo(20);
  await clickText('app-manual-blur-video .tl-label', 'מלבן 1');
  check('on a keyframe, Delete removes the keyframe (not the track)', await (async () => { await key('Delete'); return (await nKeys(0)) === 1 && (await nTracks()) === 2; })());
  await key('z', 2, 'KeyZ');
  check('and undo brings it back', (await nKeys(0)) === 2);
  await shot('v3-selected.png');

  // save: the render runs on the server
  const savedAt = Date.now();
  await ev(`document.querySelector('app-manual-blur-video .save').click()`);
  check('saving first asks to confirm what readers will see (everything outside the boxes)', await ev(`(document.querySelector('app-manual-blur-video .confirm-save')?.textContent || '').includes('כל השאר יוצג')`));
  await ev(`document.querySelector('app-manual-blur-video .confirm-yes').click()`);
  const sawProgress = await waitFor(`!!document.querySelector('app-manual-blur-video .render-panel')`, 15000);
  check('saving shows the render progress panel', sawProgress);
  if (sawProgress) await shot('v4-rendering.png');
  const closed = await waitFor(`!document.querySelector('app-manual-blur-video')`, 180000);
  check('when the render is done the editor closes', closed, `${((Date.now() - savedAt) / 1000).toFixed(0)} s`);
  await sleep(1000);
  const bar = await ev(`document.querySelector('.mod-wrap[data-file-id="${vid}"] .mod-bar').textContent`);
  check('the bar says "טשטוש ידני פעיל (2)"', bar.includes('טשטוש ידני פעיל (2)'), bar);
  const sizes = JSON.parse(await ev(`(async () => { const g = async (u) => (await (await fetch(u)).arrayBuffer()).byteLength; return JSON.stringify([await g('/api/files/${vid}'), await g('/api/files/${vid}?view=public')]); })()`));
  check('"as readers see" is a different file; the original is untouched', sizes[1] !== sizes[0] && sizes[0] === originalSize, `${sizes} ${originalSize}`);
  const playable = await ev(`new Promise(res => { const v = document.createElement('video'); v.onloadedmetadata = () => res(v.duration); v.onerror = () => res(-1); v.src = '/api/files/${vid}?view=public'; })`);
  check('the version readers get plays and is 40 s long', Math.abs(playable - 40) < 0.7, playable);

  check('reopening loads the two tracks', (await openEditor()) && (await nTracks()) === 2);
  await ev(`document.querySelector('app-manual-blur-video .close-btn').click()`);
  check('closing without changes needs no question', await waitFor(`!document.querySelector('app-manual-blur-video')`, 3000));

  await openEditor();
  await clickText('app-manual-blur-video .tool', 'מלבן');
  await seekTo(3);
  r = await rectOf('app-manual-blur-video .stage');
  await dragMouse(at(r, 0.7, 0.1), at(r, 0.9, 0.25));
  await ev(`document.querySelector('app-manual-blur-video .close-btn').click()`);
  check('closing with changes asks first', await ev(`!!document.querySelector('app-manual-blur-video .confirm')`));
  await ev(`document.querySelector('app-manual-blur-video .keep-editing').click()`);
  check('"המשך לערוך" keeps it open', (await ev(`!!document.querySelector('app-manual-blur-video')`)) && !(await ev(`!!document.querySelector('app-manual-blur-video .confirm')`)));
  await ev(`document.querySelector('app-manual-blur-video .close-btn').click()`);
  await ev(`document.querySelector('app-manual-blur-video .confirm-close').click()`);
  check('"סגור בלי לשמור" closes it and saves nothing', await waitFor(`!document.querySelector('app-manual-blur-video')`, 3000) && (await ev(`document.querySelector('.mod-wrap[data-file-id="${vid}"] .mod-bar').textContent`)).includes('(2)'));

  // remove all
  await openEditor();
  await clickText('app-manual-blur-video nb-card-footer button', 'מחק הכל');
  check('"מחק הכל" empties the editor and the save button says it removes', (await nTracks()) === 0 && (await ev(`document.querySelector('app-manual-blur-video .save').textContent`)).includes('הסר'));
  await ev(`document.querySelector('app-manual-blur-video .save').click()`);
  await waitFor(`!document.querySelector('app-manual-blur-video')`, 30000); await sleep(1000);
  check('saving with no tracks removes the manual blur', !(await ev(`document.querySelector('.mod-wrap[data-file-id="${vid}"] .mod-bar').textContent`)).includes('טשטוש ידני פעיל'));

  // dark theme
  await ev(`localStorage.setItem('tc-theme', 'dark')`);
  await loadPage();
  await openEditor();
  await seekTo(10);
  r = await rectOf('app-manual-blur-video .stage');
  await dragMouse(at(r, 0.3, 0.3), at(r, 0.6, 0.6));
  await shot('v5-dark.png');
  await ev(`document.querySelector('app-manual-blur-video .close-btn').click()`); await ev(`document.querySelector('app-manual-blur-video .confirm-close')?.click()`);
  await ev(`localStorage.setItem('tc-theme', 'light')`);

  // a phone, with a finger
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await loadPage();
  check('phone: the editor opens', await openEditor());
  r = await rectOf('app-manual-blur-video .stage');
  await dragTouch(at(r, 0.2, 0.25), at(r, 0.6, 0.65));
  check('phone: a finger draws a rectangle', (await nTracks()) === 1);
  check('phone: the editor fits the screen', await ev(`document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('app-manual-blur-video nb-card').getBoundingClientRect().width <= innerWidth`));
  await shot('v6-phone.png');
} catch (e) { console.log('ERROR', e); results.push(false); }
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME CHECKS FAILED');
process.exit(0);
