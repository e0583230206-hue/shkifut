// Shared by the browser checks that talk to the local stack: the default is http://localhost:18080, and anything that is not
// local, looks like the real demo (30206.co.il) or uses ports 8080 / 8081 (where the SSH tunnel to the demo used to listen) stops.
export function localBase(url) {
  const base = (url || 'http://localhost:18080').trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(base); } catch { u = null; }
  let problem = '';
  if (!u || !/^https?:$/.test(u.protocol)) problem = 'not an http(s) address';
  else if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) problem = 'not a local address';
  else if (/30206\.co\.il/i.test(base)) problem = 'looks like the real demo site';
  else if (['8080', '8081'].includes(u.port)) problem = `port ${u.port} may be the SSH tunnel to the real demo site`;
  if (problem) { console.error(`STOP: ${base} is refused (${problem}). Checks run only against the local stack, http://localhost:18080.`); process.exit(2); }
  return base;
}
