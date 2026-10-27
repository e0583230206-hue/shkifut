// The brush of the manual blur editor (pictures) in a real Chrome (CDP): paint a stroke, the size slider and the ring, tap for a dot, select / move /
// resize (the size) / delete / undo a stroke, the preview, save, and painting with a finger. LOCAL stack only: the backend with MANUAL_BLUR=1 and the
// real moderation service (tests/docker-compose.manual-blur-render.yml, project tc-mb) and the page built with `ng build --configuration development`.
//   node tests/ui/manual_blur_brush_ui.mjs <outDir> http://localhost:18084
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [outDir, base] = process.argv.slice(2);
if (!outDir || !/^http:\/\/localhost:\d+$/.test(base || '') || /:(8080|8081)$/.test(base)) { console.error('usage: manual_blur_brush_ui.mjs <outDir> <local url>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

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
fd.append('file', new Blob([Buffer.concat([readFileSync(join(MEDIA, 'landscape_hermon.jpg')), Buffer.from(String(Math.random()))])], { type: 'image/jpeg' }), 'a.jpg');
const up = await (await api('/api/admin/upload', { method: 'POST', body: fd })).json();
const img = up.url.match(/\/api\/files\/([0-9a-f]{40})/)[1];
await post('/api/admin/files/moderation', { id: img, status: 'open' });
await post('/api/admin/new', { type: 'md', text: `ניסוי מברשת\n[image-embedded#](${up.url})` });

const profile = mkdtempSync(join(tmpdir(), 'brushui-'));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9410', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9410/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('  js error:', r.result.exceptionDetails.exception?.description?.slice(0, 200)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(120); } return false; };
const key = async (k, mods = 0, code) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: code ?? k, modifiers: mods, windowsVirtualKeyCode: { Delete: 46, z: 90, y: 89 }[k] ?? 0 }); await sleep(200); };
const rectOf = (sel) => ev(`JSON.stringify((() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })())`).then(JSON.parse);
const at = (r, fx, fy) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy });
const mouse = (type, p, buttons = 1) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1 });
const paint = async (pts) => { await mouse('mouseMoved', pts[0], 0); await mouse('mousePressed', pts[0]); for (const p of pts.slice(1)) { await mouse('mouseMoved', p); await sleep(15); } await mouse('mouseReleased', pts[pts.length - 1]); await sleep(250); };
const touchPaint = async (pts) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts[0]] });
  for (const p of pts.slice(1)) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(300);
};
const count = () => ev(`document.querySelector('app-manual-blur .count').textContent`);
const clickText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
const layerAlpha = (fx, fy) => ev(`(() => { const c = document.querySelector('app-manual-blur canvas.layer'); const x = c.getContext('2d'); return x.getImageData(Math.round(c.width * ${fx}), Math.round(c.height * ${fy}), 1, 1).data[3]; })()`);
const previewAlpha = (fx, fy) => ev(`(() => { const c = document.querySelector('app-manual-blur canvas.preview'); const x = c.getContext('2d'); return x.getImageData(Math.round(c.width * ${fx}), Math.round(c.height * ${fy}), 1, 1).data[3]; })()`);
const setSlider = (v) => ev(`(() => { const s = document.querySelector('app-manual-blur .size-slider'); s.value = '${v}'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
const openEditor = async () => {
  await ev(`(() => { const w = document.querySelector('.mod-wrap[data-file-id="${img}"]'); w.scrollIntoView({ block: 'center' }); w.querySelector('.mod-btn-manual').click(); })()`);
  return waitFor(`(() => { const i = document.querySelector('app-manual-blur .stage img'); return !!i && i.complete && i.naturalWidth > 0; })()`);
};

try {
  await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/auth/dev-login' }); await sleep(1500);
  await send('Page.navigate', { url: base + '/' });
  await waitFor(`!!document.querySelector('.mod-wrap[data-file-id="${img}"] .mod-bar')`, 30000); await sleep(500);
  check('the editor opens', await openEditor());
  check('there is a "מברשת" tool', await ev(`!!document.querySelector('app-manual-blur .brush-tool')`));
  check('no size slider until the brush is chosen', !(await ev(`!!document.querySelector('app-manual-blur .size-slider')`)));

  await clickText('app-manual-blur .tool', 'מברשת');
  check('choosing the brush shows the size slider', await ev(`!!document.querySelector('app-manual-blur .size-slider')`));
  let r = await rectOf('app-manual-blur .stage');
  await mouse('mouseMoved', at(r, 0.5, 0.5), 0); await sleep(150);
  check('the ring of the brush follows the pointer (the layer is drawn before any stroke)', (await layerAlpha(0.5, 0.5 + 0.04 * (r.w / r.h))) > 0);

  await paint([0.15, 0.2, 0.3, 0.45, 0.6, 0.75, 0.85].map((fx, i) => at(r, fx, 0.3 + 0.05 * Math.sin(i))));
  check('painting makes one stroke', (await count()).includes('1'), await count());
  check('the stroke is drawn on the layer (on its line, not away from it)', (await layerAlpha(0.45, 0.3)) > 40 && (await layerAlpha(0.45, 0.8)) === 0, `${await layerAlpha(0.45, 0.3)} / ${await layerAlpha(0.45, 0.8)}`);
  check('it is selected and has no resize handles', (await ev(`document.querySelectorAll('app-manual-blur .shape').length`)) === 0 && (await ev(`document.querySelectorAll('app-manual-blur .handle').length`)) === 0);

  await clickText('app-manual-blur .tool', 'הדמיה'); await sleep(500);
  check('the preview blurs under the stroke only', (await previewAlpha(0.45, 0.3)) === 255 && (await previewAlpha(0.45, 0.8)) === 0, `${await previewAlpha(0.45, 0.3)} / ${await previewAlpha(0.45, 0.8)}`);
  await shot('b1-stroke-preview.png');
  await clickText('app-manual-blur .tool', 'הדמיה');

  // size: the next stroke is bigger
  await setSlider('0.1');
  const px = await ev(`document.querySelector('app-manual-blur .size-px').textContent`);
  check('the size slider changes the size shown (in px)', parseInt(px) > 100, px);
  await paint([0.2, 0.4, 0.6, 0.8].map(fx => at(r, fx, 0.7)));
  check('a second stroke', (await count()).includes('2'));
  check('the second stroke is fatter than the first', (await layerAlpha(0.5, 0.7 + 0.07 * (r.w / r.h))) > 40 && (await layerAlpha(0.5, 0.3 + 0.07 * (r.w / r.h))) === 0);

  // a tap is a dot
  await paint([at(r, 0.9, 0.55)]);
  check('a tap makes a dot (a third stroke)', (await count()).includes('3') && (await layerAlpha(0.9, 0.55)) > 40);

  // select, resize (the size of a selected stroke), undo, move
  await clickText('app-manual-blur .tool', 'בחירה');
  await mouse('mouseMoved', at(r, 0.5, 0.7), 0); await mouse('mousePressed', at(r, 0.5, 0.7)); await mouse('mouseReleased', at(r, 0.5, 0.7)); await sleep(250);
  check('select tool: a click on a stroke selects it (the slider shows its size)', parseInt(await ev(`document.querySelector('app-manual-blur .size-px').textContent`)) > 100);
  await setSlider('0.03');
  check('the slider changes the size of the selected stroke', (await layerAlpha(0.5, 0.7 + 0.07 * (r.w / r.h))) === 0 && (await layerAlpha(0.5, 0.7)) > 40);
  await key('z', 2, 'KeyZ');
  check('Ctrl+Z puts the size back', parseInt(await ev(`document.querySelector('app-manual-blur .size-px').textContent`)) > 100);
  await paint([at(r, 0.5, 0.7), at(r, 0.5, 0.95)].flatMap((p, i, a) => i === 0 ? [p] : [{ x: p.x, y: a[0].y + (p.y - a[0].y) / 2 }, p]));
  check('dragging a selected stroke moves it as a whole', (await layerAlpha(0.5, 0.95)) > 40 && (await layerAlpha(0.2, 0.7)) === 0);
  await key('Delete');
  check('Delete removes the stroke', (await count()).includes('2'));
  await key('z', 2, 'KeyZ');
  check('Ctrl+Z brings it back', (await count()).includes('3'));
  await shot('b2-three-strokes.png');

  // save: confirm, then the readers get the original with the strokes blurred
  await ev(`document.querySelector('app-manual-blur .save').click()`);
  check('saving asks to confirm', await ev(`!!document.querySelector('app-manual-blur .confirm-save')`));
  await ev(`document.querySelector('app-manual-blur .confirm-yes').click()`);
  check('saved: the editor closes', await waitFor(`!document.querySelector('app-manual-blur')`, 20000));
  await sleep(800);
  check('the bar says the manual blur is active', (await ev(`document.querySelector('.mod-wrap[data-file-id="${img}"] .mod-bar').textContent`)).includes('טשטוש ידני פעיל'));
  const sizes = JSON.parse(await ev(`(async () => { const g = async (u) => (await (await fetch(u)).arrayBuffer()).byteLength; return JSON.stringify([await g('/api/files/${img}'), await g('/api/files/${img}?view=public')]); })()`));
  check('"as readers see" differs from the original', sizes[0] !== sizes[1], String(sizes));

  // reopen: the strokes are loaded; then a finger on a phone
  check('reopening loads the three strokes', (await openEditor()) && (await count()).includes('3'));
  await ev(`document.querySelector('app-manual-blur .close-btn').click()`);
  await sleep(500);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url: base + '/' });
  await waitFor(`!!document.querySelector('.mod-wrap[data-file-id="${img}"] .mod-bar')`, 30000); await sleep(500);
  check('phone: the editor opens', await openEditor());
  await clickText('app-manual-blur .clear', 'מחק את כל'); await sleep(200);
  await clickText('app-manual-blur .tool', 'מברשת');
  r = await rectOf('app-manual-blur .stage');
  await touchPaint([0.2, 0.35, 0.5, 0.65, 0.8].map(fx => at(r, fx, 0.5)));
  check('phone: a finger paints a stroke', (await count()).includes('1') && (await layerAlpha(0.5, 0.5)) > 40);
  check('phone: the editor fits the screen', await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
  await shot('b3-phone.png');
} catch (e) { console.log('ERROR', e); results.push(false); }
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME CHECKS FAILED');
process.exit(0);
