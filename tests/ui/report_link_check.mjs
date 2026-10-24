// The "report problematic content" link: what a click asks the browser to open (subject, body), and whether the note is hidden by the fixed
// input form on a phone in the admin view. LOCAL stack only.   node tests/ui/report_link_check.mjs <outDir> http://localhost:18083
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [outDir, base] = process.argv.slice(2);
if (!outDir || !/^http:\/\/localhost:\d+$/.test(base || '')) { console.error('usage: report_link_check.mjs <outDir> <local url>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9402', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rl-'))}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9402/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const events = [];
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method) events.push(d); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + d)); };
await send('Page.enable');

// 1. a real click on a phone, visitor: which address does the browser get asked to open?
await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: base + '/' }); await sleep(7000);
await ev('window.scrollTo(0, 99999)'); await sleep(800);
const pt = JSON.parse(await ev(`JSON.stringify((() => { const r = [...document.querySelectorAll('.report-note a')].find(a => a.getBoundingClientRect().width > 0).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
events.length = 0;
for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
await sleep(1200);
const nav = events.filter(e => e.method === 'Page.frameRequestedNavigation').map(e => e.params.url);
console.log('browser asked to open:', nav);
const href = nav.find(u => u.startsWith('mailto:')) || '';
const u = new URL(href || 'mailto:x');
check('click asks the browser to open a mailto: link', href.startsWith('mailto:'), JSON.stringify(nav));
check('address is the report address', decodeURIComponent(u.pathname).toLowerCase() === '0583230206p@gmail.com', u.pathname);
check('subject is "דיווח על תוכן באתר שקיפות"', u.searchParams.get('subject') === 'דיווח על תוכן באתר שקיפות', u.searchParams.get('subject'));
check('body is one empty line', u.searchParams.get('body') === '\n', JSON.stringify(u.searchParams.get('body')));
check('the address is not shown as text anywhere on the page', !(await ev(`document.body.innerText.toLowerCase().includes('0583230206')`)));

// 2. phone, admin view with the fixed input form: is the note hidden?
await send('Page.navigate', { url: base + '/auth/dev-login' }); await sleep(1500);
await send('Page.navigate', { url: base + '/' }); await sleep(7000);
await ev('window.scrollTo(0, 99999)'); await sleep(900);
const g = JSON.parse(await ev(`JSON.stringify((() => { const n = [...document.querySelectorAll('.report-note')].find(e => e.getBoundingClientRect().width > 0)?.getBoundingClientRect(); const f = document.getElementById('inputForm')?.getBoundingClientRect(); return { note: n && [Math.round(n.top), Math.round(n.bottom)], form: f && [Math.round(f.top), Math.round(f.bottom)], innerH: innerHeight }; })())`));
console.log('admin phone:', JSON.stringify(g));
check('admin view has the input form', !!g.form);
check('admin phone: the note is above the input form (not covered)', g.note && g.form && g.note[1] <= g.form[0] + 1, JSON.stringify(g));
await shot('report-admin-360.png');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/' }); await sleep(7000); await ev('window.scrollTo(0, 99999)'); await sleep(800);
const d = JSON.parse(await ev(`JSON.stringify((() => { const n = [...document.querySelectorAll('.report-note')].find(e => e.getBoundingClientRect().width > 0)?.getBoundingClientRect(); const f = document.getElementById('inputForm')?.getBoundingClientRect(); return { note: n && [Math.round(n.top), Math.round(n.bottom)], form: f && [Math.round(f.top), Math.round(f.bottom)] }; })())`));
console.log('admin desktop:', JSON.stringify(d));
check('admin desktop: the note is above the input form', d.note && d.form && d.note[1] <= d.form[0] + 1, JSON.stringify(d));
await shot('report-admin-1280.png');
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME CHECKS FAILED'); process.exit(0);
