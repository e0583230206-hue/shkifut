"""Adds "original media -> private Google Chat space" to the WhatsApp bridge (bridge.js) and fixes its webhook text.

    python3 patch_bridge.py <dir> [--compose] [--env <spaces/ID>]

<dir> holds bridge.js (and, with --compose, docker-compose.yml and .env). Idempotent: refuses to patch twice.

bridge.js changes
  * media is downloaded from WAHA once (fetchMedia); the site still gets it through its own upload endpoint
    (checked and blurred there), exactly as before;
  * the ORIGINAL file + the WhatsApp text go to the Chat space as an attachment (chat-sender.js, authorised user);
  * the webhook now carries text only: no more "/api/files/..." links, and nothing is sent before the file is ready;
  * if the Chat upload fails the webhook says so in the space (nothing is lost silently); if the authorisation
    expired, one alert every 6 hours asks for a new authorisation.
"""
import os
import re
import sys

root = sys.argv[1]
js_path = os.path.join(root, "bridge.js")
js = open(js_path, encoding="utf-8").read()
if "chat-sender.js" in js:
    sys.exit("bridge.js is already patched")


def sub_once(pattern, repl, flags=re.S):
    global js
    new, n = re.subn(pattern, lambda m: repl, js, count=1, flags=flags)
    assert n == 1, "pattern not found: " + pattern[:60]
    js = new


# 1. the Chat sender
sub_once(r"const seen = new Set\(\);",
         "const seen = new Set();\n"
         "const { makeChatSender } = require('./chat-sender.js');\n"
         "const chat = makeChatSender({ fetch, env: E, log });")

# 2. media: download once, then (a) the site's own upload (b) the original to Chat
sub_once(r"async function saveMedia\(media\) \{.*?\n\}\n\n(?=async function postToChannel)",
         r'''// Downloads the media from WAHA once: the original goes to the private Chat space, the site gets its own upload.
async function fetchMedia(media) {
  if (!media || !media.url) return null;
  const url = media.url.replace(/^https?:\/\/[^/]+/, WAHA);
  const r = await fetch(url, { headers: { 'X-Api-Key': WAHA_KEY } });
  if (!r.ok) throw new Error('media download ' + r.status);
  const mime = (media.mimetype || r.headers.get('content-type') || '').split(';')[0].trim();
  const ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  return { buf: Buffer.from(await r.arrayBuffer()), mime, name, filename: media.filename || name };
}

// The site: uploaded through the channel's own endpoint (checked and blurred there), or served by this bridge (old way).
async function mediaToEmbed(m) {
  if (UPLOAD_URL) return await uploadToChannel(m.buf, m.name, m.mime, m.filename);
  if (!MEDIA_BASE) return null;
  fs.writeFileSync(path.join(MEDIA_DIR, m.name), m.buf);
  const link = MEDIA_BASE + '/media/' + m.name;
  if (m.mime.startsWith('image/')) return `[image-embedded#](${link})`;
  if (m.mime.startsWith('video/')) return `[video-embedded#](${link})`;
  if (m.mime.startsWith('audio/')) return `[audio-embedded#](${link})`;
  return `[${m.filename || 'קובץ'}](${link})`;
}

// The private Chat space: original media + caption as an attachment (as the authorised user). Text-only messages and
// failures go by the webhook, as plain text (never a link to the site).
let lastAuthAlert = 0;
function alertAuth() {
  if (Date.now() - lastAuthAlert < 6 * 3600 * 1000) return;
  lastAuthAlert = Date.now();
  postToGChat('⚠️ ההרשאה לשליחת מדיה לצ׳אט פגה או בוטלה. צריך להתחבר מחדש (chat_oauth.py). עד אז תמונות וסרטונים לא יישלחו לכאן.');
}
async function sendToSpace(p, media) {
  const caption = (p.body || '').trim();
  if (media && chat.enabled) {
    try {
      await chat.sendMedia({ buf: media.buf, mime: media.mime, filename: media.filename, caption });
      log('chat posted (original media)', p.id);
      return;
    } catch (e) {
      log('chat media failed:', e.message);
      if (e.authFailed) alertAuth();
    }
    postToGChat((caption ? caption + '\n' : '') + '[קובץ מדיה לא הועלה לצ׳אט - ראה את הלוג של הגשר]');
    return;
  }
  if (caption) postToGChat(caption);
}

''')

# 3. handle(): one download, site upload as before, Chat gets the original, webhook text only
sub_once(r"  const parts = \[\];\n  if \(p\.hasMedia\) \{.*?  if \(!CHANNEL_URL\) return;\n",
         r'''  const parts = [];
  let media = null; // the original file (for the private Chat space)
  if (p.hasMedia) {
    try { media = await fetchMedia(p.media); } catch (e) { log('media error', e.message); }
    if (!media) log('media without url (WAHA could not provide the file)', p.id);
    else {
      try { const emb = await mediaToEmbed(media); if (emb) parts.push(emb); }
      catch (e) { log('site media upload error', e.message); }
    }
  }
  if (p.body) parts.push(waToMd(p.body));
  if (!parts.length && !media) return;
  sendToSpace(p, media).catch(e => log('chat error', e.message)); // independent of the site post below
  if (!CHANNEL_URL || !parts.length) return;
''')

# 4. status line + keep-alive
sub_once(r"setInterval\(health, 10 \* 60 \* 1000\); setTimeout\(health, 30000\);",
         "setInterval(health, 10 * 60 * 1000); setTimeout(health, 30000);\n"
         "log('chat: ' + (chat.enabled ? 'ENABLED (original media -> ' + chat.space + ')' : 'disabled (no credentials)'));\n"
         "setInterval(() => chat.keepAlive(), 24 * 3600 * 1000); setTimeout(() => chat.keepAlive(), 60000);")

open(js_path, "w", encoding="utf-8", newline="\n").write(js)
print("bridge.js patched")

if "--compose" in sys.argv:
    cp = os.path.join(root, "docker-compose.yml")
    c = open(cp, encoding="utf-8").read()
    assert "chat-sender.js" not in c
    c, n1 = re.subn(r"^(\s*- GCHAT_WEBHOOK=.*)$",
                    r"\1\n      - GCHAT_SPACE=${GCHAT_SPACE}\n      - GCHAT_OAUTH_CLIENT_ID=${GCHAT_OAUTH_CLIENT_ID}\n"
                    r"      - GCHAT_OAUTH_CLIENT_SECRET=${GCHAT_OAUTH_CLIENT_SECRET}\n      - GCHAT_REFRESH_TOKEN=${GCHAT_REFRESH_TOKEN}",
                    c, count=1, flags=re.M)
    c, n2 = re.subn(r"^(\s*- \./bridge\.js:/app/bridge\.js:ro)$", r"\1\n      - ./chat-sender.js:/app/chat-sender.js:ro", c, count=1, flags=re.M)
    assert n1 == 1 and n2 == 1, "compose lines not found"
    open(cp, "w", encoding="utf-8", newline="\n").write(c)
    ep = os.path.join(root, ".env")
    lines = open(ep, encoding="utf-8").read().splitlines()
    have = {l.split("=", 1)[0] for l in lines if "=" in l}
    space = ""
    if "--env" in sys.argv:
        space = sys.argv[sys.argv.index("--env") + 1]
    for k, v in (("GCHAT_SPACE", space), ("GCHAT_OAUTH_CLIENT_ID", ""), ("GCHAT_OAUTH_CLIENT_SECRET", ""), ("GCHAT_REFRESH_TOKEN", "")):
        if k not in have:
            lines.append(f"{k}={v}")
    open(ep, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
    print("compose + .env prepared")
