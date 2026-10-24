// The "developed and maintained by" credit in the header: the Gmail compose address it builds and what a click opens. LOCAL stack only.
//   node tests/ui/dev_credit_check.mjs <outDir> http://localhost:18083
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [outDir, base] = process.argv.slice(2);
if (!outDir || !/^http:\/\/localhost:\d+$/.test(base || '')) { console.error('usage: dev_credit_check.mjs <outDir> <local url>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9404', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dc-'))}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9404/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const events = [];
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method) events.push(d); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + d)); };
await send('Page.enable'); await send('Target.setDiscoverTargets', { discover: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/' }); await sleep(7000);
const a = JSON.parse(await ev(`JSON.stringify((() => { const a = document.querySelector('a.dev-credit'); const r = a.getBoundingClientRect(); const i = a.querySelector('img'); return { href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.innerText.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2, img: i.getAttribute('src'), natural: [i.naturalWidth, i.naturalHeight], shown: [i.width, i.height] }; })())`));
const u = new URL(a.href);
check('text is "מפותח ומתוחזק ע"י"', a.text === 'מפותח ומתוחזק ע"י', a.text);
check('the whole GIF file is used (120x120 original, animated)', a.img.endsWith('/brand/developer.gif') && a.natural[0] === 120, JSON.stringify(a));
check('Gmail compose, view=cm, fs=1', u.origin + u.pathname === 'https://mail.google.com/mail/' && u.searchParams.get('view') === 'cm' && u.searchParams.get('fs') === '1', a.href);
check('to is the developer address', u.searchParams.get('to') === 'e0583230206@gmail.com', u.searchParams.get('to'));
check('subject is "דרך אתר שקיפות"', u.searchParams.get('su') === 'דרך אתר שקיפות', u.searchParams.get('su'));
check('new tab, noopener noreferrer', a.target === '_blank' && /noopener/.test(a.rel) && /noreferrer/.test(a.rel), a.target + ' ' + a.rel);
check('percent-encoded (ASCII only, no spaces)', /^[\x21-\x7e]+$/.test(a.href), a.href);
events.length = 0;
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: a.x, y: a.y, button: 'left', clickCount: 1 });
await sleep(2500);
const opened = events.filter(e => (e.method === 'Target.targetCreated' || e.method === 'Target.targetInfoChanged') && e.params.targetInfo.type === 'page').map(e => e.params.targetInfo.url);
check('a click on the picture area opens a new tab to Gmail (or the Google sign-in that keeps the compose address)', opened.some(x => x.startsWith('https://mail.google.com/') || (x.startsWith('https://accounts.google.com/') && x.includes('mail.google.com/mail/?view'))), JSON.stringify(opened));
check('the address is not shown as text on the page', !(await ev(`document.body.innerText.toLowerCase().includes('0583230206')`)));
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME CHECKS FAILED'); process.exit(0);
