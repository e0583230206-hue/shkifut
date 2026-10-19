// Access check for the bridge's POST /notify (the site tells the private Chat space that a video waits for approval).
// The endpoint answers only requests that come from inside the Docker network / the same machine AND carry the key.
//   - the connection must come from a loopback or private address (127/8, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7);
//   - a request that went through a reverse proxy (X-Forwarded-For, X-Real-IP, Forwarded) is refused: the proxy hides who is outside;
//   - the key (X-Notify-Key) is compared in constant time. Without a configured key the endpoint does not exist (404).
const crypto = require('crypto');

function isInternalAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  let a = addr.toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4 seen through an IPv6 socket
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some(n => n > 255)) return false;
    return o[0] === 127 || o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
  }
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a);
}

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];

function keyMatches(given, wanted) {
  const h = (s) => crypto.createHash('sha256').update(String(s || '')).digest();
  return crypto.timingSafeEqual(h(given), h(wanted));
}

// -> { ok: true } or { ok: false, status }
function checkNotifyRequest(req, wantedKey) {
  if (!wantedKey) return { ok: false, status: 404 };
  if (!isInternalAddress(req.socket && req.socket.remoteAddress)) return { ok: false, status: 403 };
  if (PROXY_HEADERS.some(h => req.headers[h] !== undefined)) return { ok: false, status: 403 };
  if (!keyMatches(req.headers['x-notify-key'], wantedKey)) return { ok: false, status: 401 };
  return { ok: true };
}

module.exports = { isInternalAddress, checkNotifyRequest };
