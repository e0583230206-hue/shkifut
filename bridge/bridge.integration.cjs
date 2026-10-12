// Runs the REAL bridge.js with every network call replaced by a recorder (WAHA, the site, Google, the Chat webhook).
//   docker run --rm -v "<repo>/bridge:/app" -e SCENARIO=media-enabled node:22-alpine node /app/bridge.integration.cjs
// One scenario per process (bridge.js starts its server on load). Prints PASS/FAIL lines; exit code 1 on failure.
const http = require('http');
const SCENARIO = process.env.SCENARIO;
const GROUP = '120363427910588351@g.us';
const ORIGINAL = Buffer.from('ORIGINAL-VIDEO-BYTES-' + 'x'.repeat(2000));
const calls = [];
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

const enabled = ['media-enabled', 'chat-fails', 'auth-fails', 'text-only', 'duplicate'].includes(SCENARIO);
Object.assign(process.env, {
  WAHA_URL: 'http://waha:3000', WAHA_API_KEY: 'waha-key', CHANNEL_API_KEY: 'site-key', GROUP_IDS: GROUP, MEDIA_DIR: '/tmp/media-test',
  CHANNEL_IMPORT_URL: 'https://site.test/api/import/post', CHANNEL_UPLOAD_URL: 'https://site.test/api/import/upload',
  GCHAT_WEBHOOK: 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=K&token=T',
});
if (enabled) Object.assign(process.env, { GCHAT_SPACE: 'spaces/AAAA', GCHAT_OAUTH_CLIENT_ID: 'cid', GCHAT_OAUTH_CLIENT_SECRET: 'sec', GCHAT_REFRESH_TOKEN: 'rt' });

const R = (status, obj, headers = {}) => new Response(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj), { status, headers });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const body = init.body;
  calls.push({ method: init.method || 'GET', url, body, headers: init.headers || {} });
  if (url.startsWith('http://waha:3000')) return R(200, ORIGINAL, { 'content-type': 'video/mp4' });
  if (url === 'https://site.test/api/import/upload') return R(200, { url: '/api/files/aabbccddeeff00112233445566778899aabbccdd.mp4', filename: 'x.mp4', filetype: 'video' });
  if (url === 'https://site.test/api/import/post') return R(200, { id: 1 });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return SCENARIO === 'auth-fails' ? R(400, { error: 'invalid_grant' }) : R(200, { access_token: 'at', expires_in: 3600 });
  if (url.includes('/attachments:upload')) return SCENARIO === 'chat-fails' ? R(403, { error: { message: 'not a member of the space' } }) : R(200, { attachmentDataRef: { attachmentUploadToken: 'UP' } });
  if (url === 'https://chat.googleapis.com/v1/spaces/AAAA/messages') return R(200, { name: 'spaces/AAAA/messages/1' });
  if (url.startsWith('https://chat.googleapis.com/v1/spaces/AAAA/messages?key=')) return R(200, {}); // the webhook
  return R(404, {});
};

require('./bridge.js');

const send = (payload) => new Promise((res) => {
  const body = JSON.stringify({ event: 'message.any', payload });
  const r = http.request({ host: '127.0.0.1', port: 8080, path: '/webhook', method: 'POST' }, (x) => { x.resume(); x.on('end', res); });
  r.end(body);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byUrl = (s) => calls.filter(c => c.url.includes(s));
const webhookPosts = () => calls.filter(c => c.url.includes('?key=K&token=T')).map(c => JSON.parse(c.body).text);
const asBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b instanceof Uint8Array ? b : String(b)));

(async () => {
  await sleep(300);
  const media = { id: 'm1', from: GROUP, participant: '972500000000@c.us', hasMedia: true, body: 'כיתוב *חשוב*', media: { url: 'http://localhost:3000/api/files/default/abc.mp4', mimetype: 'video/mp4' } };
  const base = { from: GROUP, participant: '972500000000@c.us' };

  if (SCENARIO === 'media-enabled') {
    await send(media); await sleep(500);
    const up = byUrl('/attachments:upload')[0];
    check('the original bytes were uploaded to Chat untouched', !!up && asBuf(up.body).includes(ORIGINAL));
    const msg = calls.find(c => c.url === 'https://chat.googleapis.com/v1/spaces/AAAA/messages');
    check('Chat message carries the WhatsApp caption and the attachment', !!msg && JSON.parse(msg.body).text === 'כיתוב *חשוב*' && JSON.parse(msg.body).attachment[0].attachmentDataRef.attachmentUploadToken === 'UP');
    check('the site still gets the file through its own upload endpoint (blurred there)', byUrl('site.test/api/import/upload').length === 1);
    const post = byUrl('site.test/api/import/post')[0];
    check('the site message embeds the site-hosted file and the text', !!post && /\[video-embedded#\]\(\/api\/files\/[0-9a-f]{40}\.mp4\)/.test(JSON.parse(post.body).text) && JSON.parse(post.body).text.includes('כיתוב'));
    check('NOTHING goes by the webhook for a media message (no broken /api/files link)', webhookPosts().length === 0, JSON.stringify(webhookPosts()));
    check('original media is never sent to the site endpoint as a link (only uploaded)', byUrl('site.test/api/import/upload')[0].body instanceof FormData);
  }
  if (SCENARIO === 'media-disabled') {
    await send(media); await sleep(500);
    check('no Chat API calls without credentials', byUrl('chat.googleapis.com/upload').length === 0 && byUrl('oauth2').length === 0);
    check('the webhook gets the caption as plain text only', JSON.stringify(webhookPosts()) === JSON.stringify(['כיתוב *חשוב*']), JSON.stringify(webhookPosts()));
    check('the webhook text has no site link', !webhookPosts().join('').includes('/api/files'));
    check('the site still receives the media and the text', byUrl('site.test/api/import/upload').length === 1 && byUrl('site.test/api/import/post').length === 1);
  }
  if (SCENARIO === 'text-only') {
    await send({ ...base, id: 't1', hasMedia: false, body: 'חדשות בלבד' }); await sleep(400);
    check('text-only: webhook gets the text, as before', JSON.stringify(webhookPosts()) === JSON.stringify(['חדשות בלבד']));
    check('text-only: the site gets the text', byUrl('site.test/api/import/post').length === 1);
    check('text-only: no Chat API call', byUrl('chat.googleapis.com/upload').length === 0 && byUrl('oauth2').length === 0);
  }
  if (SCENARIO === 'chat-fails') {
    await send(media); await sleep(500);
    check('a failed Chat upload is announced in the space (not silent)', webhookPosts().length === 1 && webhookPosts()[0].includes('כיתוב') && webhookPosts()[0].includes('לא הועלה לצ׳אט'), JSON.stringify(webhookPosts()));
    check('the site is unaffected by the Chat failure', byUrl('site.test/api/import/post').length === 1);
  }
  if (SCENARIO === 'auth-fails') {
    await send({ ...media, id: 'm1' }); await send({ ...media, id: 'm2' }); await sleep(600);
    const posts = webhookPosts();
    check('expired authorisation: exactly one alert is sent', posts.filter(t => t.includes('ההרשאה לשליחת מדיה')).length === 1, JSON.stringify(posts));
    check('expired authorisation: each file is still reported as not uploaded', posts.filter(t => t.includes('לא הועלה לצ׳אט')).length === 2);
    check('nothing was uploaded to Chat without a valid token', byUrl('/attachments:upload').length === 0);
    check('the site got both messages', byUrl('site.test/api/import/post').length === 2);
  }
  if (SCENARIO === 'other-group') {
    await send({ ...media, from: '999@g.us', id: 'o1' }); await sleep(300);
    check('a message from another group is ignored completely', calls.length === 0, JSON.stringify(calls.map(c => c.url)));
  }
  if (SCENARIO === 'duplicate') {
    await send(media); await send(media); await sleep(600);
    check('the same WhatsApp message is handled once', byUrl('/attachments:upload').length === 1 && byUrl('site.test/api/import/post').length === 1);
  }
  process.exit(results.every(Boolean) ? 0 : 1);
})();
