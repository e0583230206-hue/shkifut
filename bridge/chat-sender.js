// Sends WhatsApp media (the ORIGINAL file) to a private Google Chat space as an attachment, through the Chat API,
// as the Google user who authorised it once (OAuth refresh token). Mounted into the bridge container and
// loaded by bridge.js:  const { makeChatSender } = require('./chat-sender.js');
//
// Needs (environment): GCHAT_SPACE ("spaces/AAAA..."), GCHAT_OAUTH_CLIENT_ID, GCHAT_OAUTH_CLIENT_SECRET,
// GCHAT_REFRESH_TOKEN. Without all four the sender is disabled and the bridge keeps using the webhook for text.
//
// Chat API facts (developers.google.com/workspace/chat/upload-media-attachments):
//  - uploading an attachment needs USER authentication (scope chat.messages.create), up to 200 MB;
//  - the message is then created with that upload token and shows in Chat's own player.
'use strict';
const crypto = require('crypto');

const MAX_BYTES = 195 * 1024 * 1024; // Chat limit is 200 MB
const MAX_TEXT = 4000;               // Chat message text limit is 4096 characters

function makeChatSender({ fetch, env, log = () => {}, now = () => Date.now() }) {
  const CLIENT_ID = env.GCHAT_OAUTH_CLIENT_ID || '';
  const CLIENT_SECRET = env.GCHAT_OAUTH_CLIENT_SECRET || '';
  const REFRESH = env.GCHAT_REFRESH_TOKEN || '';
  const SPACE = env.GCHAT_SPACE || '';
  const enabled = !!(CLIENT_ID && CLIENT_SECRET && REFRESH && /^spaces\/[\w-]+$/.test(SPACE));

  let token = null;
  let expiresAt = 0;

  async function accessToken(force = false) {
    if (!force && token && now() < expiresAt - 60000) return token;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH, grant_type: 'refresh_token' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const err = new Error('Google token refresh failed: ' + (j.error || r.status));
      // The authorisation is gone (revoked, expired in Testing mode, wrong client): needs a person to authorise again.
      err.authFailed = ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(j.error);
      throw err;
    }
    token = j.access_token;
    expiresAt = now() + (j.expires_in || 3600) * 1000;
    return token;
  }

  // One Google call with the bearer token; a 401 refreshes the token once and retries.
  async function call(url, init) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await accessToken(attempt > 0);
      const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + t } });
      if (r.status === 401 && attempt === 0) continue;
      if (!r.ok) {
        const body = (await r.text()).slice(0, 300);
        const err = new Error(`Chat API ${r.status}: ${body}`);
        err.status = r.status;
        throw err;
      }
      return r.json();
    }
  }

  // Step 1: upload the bytes (multipart/related: JSON metadata + the file). Returns the upload token.
  async function upload(buf, filename, mime) {
    if (buf.length > MAX_BYTES) throw new Error(`file is ${Math.round(buf.length / 1048576)} MB, over the Chat limit`);
    const boundary = 'chat' + crypto.randomBytes(12).toString('hex');
    const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename })}\r\n--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--`);
    const out = await call(`https://chat.googleapis.com/upload/v1/${SPACE}/attachments:upload?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: Buffer.concat([head, buf, tail]),
    });
    const tokenOut = out && out.attachmentDataRef && out.attachmentDataRef.attachmentUploadToken;
    if (!tokenOut) throw new Error('Chat upload returned no attachment token');
    return tokenOut;
  }

  // Step 2: a message (as the authorised user) with the caption and the uploaded file attached.
  async function sendMedia({ buf, mime, filename, caption }) {
    if (!enabled) throw new Error('Chat sender is not configured');
    const uploadToken = await upload(buf, filename, mime);
    const out = await call(`https://chat.googleapis.com/v1/${SPACE}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: (caption || '').slice(0, MAX_TEXT), attachment: [{ attachmentDataRef: { attachmentUploadToken: uploadToken } }] }),
    });
    return out && out.name;
  }

  // Keeps the refresh token "used" (Google drops tokens unused for 6 months) and shows a problem early.
  async function keepAlive() {
    if (!enabled) return;
    try { await accessToken(true); } catch (e) { log('chat keep-alive failed:', e.message); }
  }

  return { enabled, space: SPACE, accessToken, upload, sendMedia, keepAlive };
}

module.exports = { makeChatSender };
