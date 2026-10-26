// Runs the REAL bridge.js with every network call replaced by a recorder (WAHA, the site, Google, the Chat webhook).
//   docker run --rm -v "<repo>/bridge:/app" -e SCENARIO=media-enabled node:22-alpine node /app/bridge.integration.cjs
// One scenario per process (bridge.js starts its server on load). Prints PASS/FAIL lines; exit code 1 on failure.
const http = require('http');
const SCENARIO = process.env.SCENARIO;
const GROUP = '120363427910588351@g.us';
const ORIGINAL = Buffer.from('ORIGINAL-VIDEO-BYTES-' + 'x'.repeat(2000));
const calls = [];
let siteSeq = 0;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

const enabled = ['media-enabled', 'chat-fails', 'auth-fails', 'text-only', 'duplicate', 'edit-events', 'command-noise'].includes(SCENARIO);
Object.assign(process.env, {
  WAHA_URL: 'http://waha:3000', WAHA_API_KEY: 'waha-key', CHANNEL_API_KEY: 'site-key', GROUP_IDS: GROUP, MEDIA_DIR: '/tmp/media-test',
  CHANNEL_IMPORT_URL: 'https://site.test/api/import/post', CHANNEL_UPLOAD_URL: 'https://site.test/api/import/upload',
  GCHAT_WEBHOOK: 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=K&token=T',
});
if (SCENARIO === 'notify') process.env.NOTIFY_KEY = 'nk-123';
if (enabled) Object.assign(process.env, { GCHAT_SPACE: 'spaces/AAAA', GCHAT_OAUTH_CLIENT_ID: 'cid', GCHAT_OAUTH_CLIENT_SECRET: 'sec', GCHAT_REFRESH_TOKEN: 'rt' });

const R = (status, obj, headers = {}) => new Response(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj), { status, headers });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const body = init.body;
  calls.push({ method: init.method || 'GET', url, body, headers: init.headers || {} });
  if (url.startsWith('http://waha:3000')) return R(200, ORIGINAL, { 'content-type': 'video/mp4' });
  if (url === 'https://site.test/api/import/upload') return R(200, { url: '/api/files/aabbccddeeff00112233445566778899aabbccdd.mp4', filename: 'x.mp4', filetype: 'video' });
  if (url === 'https://site.test/api/import/post') return R(200, { id: ++siteSeq });   // the real site answers with the message it made
  if (url.startsWith('https://oauth2.googleapis.com/token')) return SCENARIO === 'auth-fails' ? R(400, { error: 'invalid_grant' }) : R(200, { access_token: 'at', expires_in: 3600 });
  if (url.includes('/attachments:upload')) return SCENARIO === 'chat-fails' ? R(403, { error: { message: 'not a member of the space' } }) : R(200, { attachmentDataRef: { attachmentUploadToken: 'UP' } });
  if (url === 'https://chat.googleapis.com/v1/spaces/AAAA/messages') return R(200, { name: 'spaces/AAAA/messages/1' });
  if (url.startsWith('https://chat.googleapis.com/v1/spaces/AAAA/messages?key=')) return R(200, {}); // the webhook
  return R(404, {});
};

require('./bridge.js');

const send = (payload, event = 'message.any') => new Promise((res) => {
  const body = JSON.stringify({ event, payload });
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
  if (SCENARIO === 'edit-events') {
    // A plain WhatsApp edit / delete arrives as message.edited / message.revoked. It must not become a second post.
    await send({ ...base, id: 't1', hasMedia: false, body: 'טקסט מקורי' }); await sleep(300);
    await send({ ...base, id: 't2', editedMessageId: 't1', hasMedia: false, body: 'טקסט מתוקן' }, 'message.edited'); // new id
    await send({ ...base, id: 't1', editedMessageId: 't1', hasMedia: false, body: 'טקסט מתוקן' }, 'message.edited'); // same id
    await send({ ...base, id: 't9', editedMessageId: 'unknown-after-restart', hasMedia: false, body: 'עריכה יתומה' }, 'message.edited');
    await send({ ...base, id: 't3', editedMessageId: 't1', hasMedia: false, body: 'עריכה שהגיעה כאירוע רגיל' }); // edit marker on a normal event
    await send({ ...base, id: 'r1', revokedMessageId: 't1', hasMedia: false, body: '' }, 'message.revoked');
    await sleep(500);
    const posts = byUrl('site.test/api/import/post').map(c => JSON.parse(c.body).text);
    check('only the original reaches the site; edits and revokes do not', JSON.stringify(posts) === JSON.stringify(['טקסט מקורי']), JSON.stringify(posts));
    check('only the original reaches the private Chat', JSON.stringify(webhookPosts()) === JSON.stringify(['טקסט מקורי']), JSON.stringify(webhookPosts()));
  }
  if (SCENARIO === 'command-noise') {
    const noise = ['✅ הודעה עודכנה!', '✅ הצלחות: 3', '❌ שגיאות: 1', '📣 ערוצי טלגרם', '⏳ מעדכן הודעה', 'מעדכן הודעה', 'לא נמצאה במערכת',
      '✅ הצלחות: 3\n❌ שגיאות: 0','!ערוך 123 טקסט חדש', '!מחק 123', '‏!מחק 123'];
    // the editing bot's real messages (posted to the site on 25.10.2026)
    noise.push('⏳ מעדכן הודעה ב-3 קבוצות ו-1 ערוצי טלגרם...', '✅ הודעה עודכנה!\n\n✅ הצלחות: 3\n❌ שגיאות: 0\n📣 ערוצי טלגרם: 1/1');
    let i = 0;
    for (const body of noise) { await send({ ...base, id: 'n' + (i++), hasMedia: false, body }); }
    await sleep(400);
    check('status noise and !ערוך / !מחק reach neither the site nor the private Chat', calls.length === 0, JSON.stringify(calls.map(c => c.url)));
    const keep = ['הודעה עודכנה אחרי הפגישה, תודה', 'הערוץ ערוצי טלגרם הוא אחד מכמה', 'סיימנו בהצלחה', 'מחק את זה מהרשימה'];
    for (const body of keep) { await send({ ...base, id: 'k' + (i++), hasMedia: false, body }); }
    await sleep(500);
    const posts = byUrl('site.test/api/import/post').map(c => JSON.parse(c.body).text);
    check('ordinary messages that merely contain those words are posted', JSON.stringify(posts) === JSON.stringify(keep), JSON.stringify(posts));
  }
  if (SCENARIO === 'reply') {
    // A WhatsApp reply names the message it answers by its short id; the bridge quotes it only when that message is on the site.
    const full = (stanza) => `false_${GROUP}_${stanza}_106953342742588@lid`;
    await send({ ...base, id: full('AAAA1111'), hasMedia: false, body: 'ידיעה ראשונה' }); await sleep(300);
    await send({ ...base, id: full('BBBB2222'), hasMedia: false, body: 'תגובה *חשובה*', replyTo: { id: 'AAAA1111', body: 'ידיעה ראשונה', hasMedia: false, participant: '972500000000@c.us' } }); await sleep(300);
    await send({ ...base, id: full('CCCC3333'), hasMedia: false, body: 'עוד תגובה', replyTo: { id: 'NOTPOSTED9', body: 'טקסט פנימי שלא פורסם', hasMedia: false } }); await sleep(300);
    await send({ ...base, id: full('DDDD4444'), hasMedia: false, body: 'תגובה לציטוט עם סימנים', replyTo: { id: full('AAAA1111'), body: '<script>x</script> [קישור](http://a) *מודגש*\nשורה שנייה (בסוגריים)', hasMedia: false } }); await sleep(300);
    await send({ ...base, id: full('EEEE5555'), hasMedia: false, body: 'תשובה לתמונה', replyTo: { id: 'AAAA1111', body: '', hasMedia: true } }); await sleep(300);
    await send({ ...base, id: full('AAAA1111'), hasMedia: false, body: 'ידיעה ראשונה' }); await sleep(400);   // delivered a second time (after a reconnect)
    const posts = byUrl('site.test/api/import/post').map(c => JSON.parse(c.body).text);
    check('a message that is not a reply is posted as it is', posts[0] === 'ידיעה ראשונה', JSON.stringify(posts[0]));
    check('a reply gets the quote line with the number the site gave the first message', posts[1] === '[quote-embedded#](1@ידיעה ראשונה)\nתגובה **חשובה**', JSON.stringify(posts[1]));
    check('a reply to a message that is not on the site has no quote, and the text of that message is not carried over', posts[2] === 'עוד תגובה' && !JSON.stringify(posts).includes('פנימי'), JSON.stringify(posts[2]));
    check('markup, HTML and brackets in the quoted text cannot break the quote line or reach the page', /^\[quote-embedded#\]\(1@[^()<>\[\]@\n]*\)\nתגובה לציטוט עם סימנים$/.test(posts[3]) && !posts[3].includes('<script'), JSON.stringify(posts[3]));
    check('a reply to a message that had only media quotes the word "מדיה", never the media', posts[4] === '[quote-embedded#](1@מדיה)\nתשובה לתמונה' && byUrl('/api/files').length === 0, JSON.stringify(posts[4]));
    check('a message that WhatsApp delivers again is not posted twice', posts.length === 5, String(posts.length));
  }
  if (SCENARIO === 'capture' || SCENARIO === 'capture-expired') {
    // Capture mode: a file with the end time. While it is open everything goes to the Chat as text and NOTHING to the site, also from the channel's group.
    const fs = require('fs');
    fs.mkdirSync('/tmp/media-test', { recursive: true });
    fs.writeFileSync('/tmp/media-test/capture-until', String(Date.now() + (SCENARIO === 'capture' ? 60000 : -1000)));
    const personal = { from: '972501112222@c.us', hasMedia: false, _data: { Info: { PushName: 'דנה' } } };
    await send({ ...base, id: 'c1', hasMedia: false, body: 'חדשות מהקבוצה של הערוץ' }); await sleep(250);
    await send({ ...personal, id: 'c2', body: 'הודעה אישית' }); await sleep(250);
    await send({ fromMe: true, id: 'c3', from: '972500000000@c.us', to: '972509999999@c.us', hasMedia: false, body: 'אני כתבתי' }); await sleep(250);
    await send({ ...personal, id: 'c4', hasMedia: true, body: 'תמונה אישית', media: { url: 'http://localhost:3000/api/files/default/p.jpg', mimetype: 'image/jpeg' } }); await sleep(250);
    await send({ id: 'c5', from: 'status@broadcast', hasMedia: false, body: 'סטטוס של מישהו' }); await sleep(250);
    await send({ ...personal, id: 'c2', body: 'הודעה אישית' }); await sleep(300);   // delivered twice
    const texts = webhookPosts();
    if (SCENARIO === 'capture') {
      check('the channel group, a personal chat, my own message and a picture went to the Chat as text', texts.length === 4 && texts[0].includes('חדשות מהקבוצה של הערוץ') && texts[1].includes('דנה') && texts[2].includes('אני') && texts[3].includes('[מדיה: image/jpeg - לא נשלחה]'), JSON.stringify(texts));
      check('NOTHING reached the site: no post, no upload (not even the channel group)', byUrl('site.test').length === 0, JSON.stringify(byUrl('site.test').map(c => c.url)));
      check('the media of the personal chat was not downloaded and not sent to Chat as a file', byUrl('waha:3000').length === 0 && byUrl('/attachments:upload').length === 0 && !texts.join('').includes('http'));
      check('a status post is not forwarded, and a message delivered twice is forwarded once', !texts.join('').includes('סטטוס של מישהו') && texts.filter(t => t.includes('הודעה אישית')).length === 1);
    } else {
      check('the window has passed: the channel group goes to the site as always', byUrl('site.test/api/import/post').length === 1 && JSON.parse(byUrl('site.test/api/import/post')[0].body).text === 'חדשות מהקבוצה של הערוץ');
      check('... and a personal chat goes nowhere', !JSON.stringify(calls).includes('הודעה אישית') && !JSON.stringify(calls).includes('אני כתבתי'), JSON.stringify(texts));
    }
  }
  if (SCENARIO === 'notify' || SCENARIO === 'notify-off') {
    const post = (headers, body, method = 'POST') => new Promise((res) => {
      const r = http.request({ host: '127.0.0.1', port: 8080, path: '/notify', method, headers }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); });
      r.end(body);
    });
    const ok = JSON.stringify({ text: 'סרטון חדש ממתין לאישור https://site.test/review/abc' });
    if (SCENARIO === 'notify') {
      check('notify without a key: 401', (await post({}, ok)) === 401);
      check('notify with a wrong key: 401', (await post({ 'X-Notify-Key': 'nope' }, ok)) === 401);
      check('notify through a proxy (X-Forwarded-For) with the right key: 403', (await post({ 'X-Notify-Key': 'nk-123', 'X-Forwarded-For': '8.8.8.8' }, ok)) === 403);
      check('nothing was sent to Chat by the refused requests', webhookPosts().length === 0, JSON.stringify(webhookPosts()));
      check('notify with a bad body: 400', (await post({ 'X-Notify-Key': 'nk-123' }, '{}')) === 400);
      check('notify GET: 404', (await post({ 'X-Notify-Key': 'nk-123' }, undefined, 'GET')) === 404);
      check('notify with the key from the local network: 200', (await post({ 'X-Notify-Key': 'nk-123' }, ok)) === 200);
      await sleep(200);
      check('the text went to the private Chat by the webhook, text only', JSON.stringify(webhookPosts()) === JSON.stringify([JSON.parse(ok).text]), JSON.stringify(webhookPosts()));
      check('no media call and no site call', byUrl('site.test').length === 0 && byUrl('/attachments:upload').length === 0);
    } else {
      check('no NOTIFY_KEY configured: the endpoint does not exist (404)', (await post({ 'X-Notify-Key': 'anything' }, ok)) === 404);
      check('nothing was sent to Chat', webhookPosts().length === 0);
    }
  }
  process.exit(results.every(Boolean) ? 0 : 1);
})();
