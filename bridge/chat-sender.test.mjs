// node --test bridge/chat-sender.test.mjs      (Google is simulated: nothing leaves the machine)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { makeChatSender } = createRequire(import.meta.url)('./chat-sender.js');

const ENV = { GCHAT_SPACE: 'spaces/AAAA-bbb', GCHAT_OAUTH_CLIENT_ID: 'cid', GCHAT_OAUTH_CLIENT_SECRET: 'sec', GCHAT_REFRESH_TOKEN: 'refresh-1' };
const json = (status, obj) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });

// A scripted fake of Google: records every call, answers by URL.
function fakeGoogle(overrides = {}) {
  const calls = [];
  let tokens = 0;
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (overrides.handler) { const r = overrides.handler(String(url), init, calls); if (r) return r; }
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) { tokens++; return json(200, { access_token: 'access-' + tokens, expires_in: 3600 }); }
    if (String(url).includes('/attachments:upload')) return json(200, { attachmentDataRef: { resourceName: 'x', attachmentUploadToken: 'UPLOAD-TOKEN' } });
    if (String(url).endsWith('/messages')) return json(200, { name: 'spaces/AAAA-bbb/messages/m1' });
    return json(404, { error: 'unexpected' });
  };
  return { fetch, calls };
}

test('disabled unless all four settings are present', () => {
  for (const missing of Object.keys(ENV)) {
    const env = { ...ENV, [missing]: '' };
    assert.equal(makeChatSender({ fetch: async () => {}, env }).enabled, false, missing);
  }
  assert.equal(makeChatSender({ fetch: async () => {}, env: { ...ENV, GCHAT_SPACE: 'AAAA' } }).enabled, false, 'space must look like spaces/ID');
  assert.equal(makeChatSender({ fetch: async () => {}, env: ENV }).enabled, true);
});

test('sendMedia: token refresh, multipart upload, then a message that carries the upload token', async () => {
  const g = fakeGoogle();
  const chat = makeChatSender({ fetch: g.fetch, env: ENV });
  const bytes = Buffer.from([1, 2, 3, 4, 5, 250, 251]);
  const name = await chat.sendMedia({ buf: bytes, mime: 'video/mp4', filename: 'clip.mp4', caption: 'כיתוב *מודגש*' });
  assert.equal(name, 'spaces/AAAA-bbb/messages/m1');
  assert.equal(g.calls.length, 3);

  const [tok, up, msg] = g.calls;
  assert.equal(tok.url, 'https://oauth2.googleapis.com/token');
  const form = new URLSearchParams(String(tok.init.body));
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'refresh-1');
  assert.equal(form.get('client_id'), 'cid');

  assert.equal(up.url, 'https://chat.googleapis.com/upload/v1/spaces/AAAA-bbb/attachments:upload?uploadType=multipart');
  assert.equal(up.init.headers.Authorization, 'Bearer access-1');
  assert.match(up.init.headers['Content-Type'], /^multipart\/related; boundary=chat[0-9a-f]+$/);
  const body = up.init.body;
  assert.ok(Buffer.isBuffer(body));
  assert.ok(body.includes(Buffer.from('{"filename":"clip.mp4"}')), 'JSON metadata part');
  assert.ok(body.includes(Buffer.from('Content-Type: video/mp4')), 'file part content type');
  assert.ok(body.includes(bytes), 'the original bytes are sent untouched');

  assert.equal(msg.url, 'https://chat.googleapis.com/v1/spaces/AAAA-bbb/messages');
  assert.equal(msg.init.headers.Authorization, 'Bearer access-1');
  assert.deepEqual(JSON.parse(msg.init.body), { text: 'כיתוב *מודגש*', attachment: [{ attachmentDataRef: { attachmentUploadToken: 'UPLOAD-TOKEN' } }] });
});

test('the access token is reused until it is about to expire', async () => {
  const g = fakeGoogle();
  let t = 0;
  const chat = makeChatSender({ fetch: g.fetch, env: ENV, now: () => t });
  await chat.sendMedia({ buf: Buffer.from('a'), mime: 'image/jpeg', filename: 'a.jpg', caption: '' });
  await chat.sendMedia({ buf: Buffer.from('b'), mime: 'image/jpeg', filename: 'b.jpg', caption: '' });
  assert.equal(g.calls.filter(c => c.url.includes('oauth2')).length, 1, 'one refresh for two sends');
  t = 3600 * 1000; // an hour later
  await chat.sendMedia({ buf: Buffer.from('c'), mime: 'image/jpeg', filename: 'c.jpg', caption: '' });
  assert.equal(g.calls.filter(c => c.url.includes('oauth2')).length, 2, 'refreshed again after expiry');
});

test('a 401 from Chat refreshes the token once and retries', async () => {
  let uploads = 0;
  const g = fakeGoogle({ handler: (url) => (url.includes('/attachments:upload') && ++uploads === 1 ? json(401, { error: 'expired' }) : null) });
  const chat = makeChatSender({ fetch: g.fetch, env: ENV });
  await chat.sendMedia({ buf: Buffer.from('x'), mime: 'image/png', filename: 'x.png', caption: 'c' });
  assert.equal(uploads, 2);
  assert.equal(g.calls.filter(c => c.url.includes('oauth2')).length, 2);
  assert.equal(g.calls.find(c => c.url.includes('attachments:upload') && c !== g.calls[1]).init.headers.Authorization, 'Bearer access-2');
});

test('a revoked or expired authorisation is reported as authFailed (a person must authorise again)', async () => {
  const g = fakeGoogle({ handler: (url) => (url.includes('oauth2') ? json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) : null) });
  const chat = makeChatSender({ fetch: g.fetch, env: ENV });
  await assert.rejects(chat.sendMedia({ buf: Buffer.from('x'), mime: 'image/png', filename: 'x.png', caption: '' }), (e) => e.authFailed === true && /invalid_grant/.test(e.message));
  assert.equal(g.calls.length, 1, 'nothing is uploaded without a valid token');
});

test('other Chat errors carry the status and are not authFailed (e.g. not a member of the space)', async () => {
  const g = fakeGoogle({ handler: (url) => (url.includes('/attachments:upload') ? json(403, { error: { message: 'The caller is not a member of the space' } }) : null) });
  const chat = makeChatSender({ fetch: g.fetch, env: ENV });
  await assert.rejects(chat.sendMedia({ buf: Buffer.from('x'), mime: 'image/png', filename: 'x.png', caption: '' }), (e) => e.status === 403 && !e.authFailed && /not a member/.test(e.message));
});

test('long captions are cut to the Chat limit; oversized files are refused before any upload', async () => {
  const g = fakeGoogle();
  const chat = makeChatSender({ fetch: g.fetch, env: ENV });
  await chat.sendMedia({ buf: Buffer.from('x'), mime: 'image/png', filename: 'x.png', caption: 'א'.repeat(5000) });
  assert.equal(JSON.parse(g.calls.at(-1).init.body).text.length, 4000);

  const g2 = fakeGoogle();
  const chat2 = makeChatSender({ fetch: g2.fetch, env: ENV });
  await assert.rejects(chat2.upload({ length: 196 * 1024 * 1024 }, 'big.mp4', 'video/mp4'), /over the Chat limit/);
  assert.equal(g2.calls.length, 0);
});

test('sendMedia on a disabled sender fails clearly and calls nothing', async () => {
  const g = fakeGoogle();
  const chat = makeChatSender({ fetch: g.fetch, env: {} });
  await assert.rejects(chat.sendMedia({ buf: Buffer.from('x'), mime: 'a/b', filename: 'x', caption: '' }), /not configured/);
  assert.equal(g.calls.length, 0);
});

test('keepAlive refreshes quietly and never throws', async () => {
  const logs = [];
  const bad = fakeGoogle({ handler: (url) => (url.includes('oauth2') ? json(400, { error: 'invalid_grant' }) : null) });
  await makeChatSender({ fetch: bad.fetch, env: ENV, log: (...a) => logs.push(a.join(' ')) }).keepAlive();
  assert.ok(logs.some(l => /keep-alive failed/.test(l)));
  const ok = fakeGoogle();
  await makeChatSender({ fetch: ok.fetch, env: ENV }).keepAlive();
  assert.equal(ok.calls.length, 1);
});
