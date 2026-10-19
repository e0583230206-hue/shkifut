// node --test bridge/notify-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isInternalAddress, checkNotifyRequest } = createRequire(import.meta.url)('./notify-guard.js');

test('internal addresses are accepted', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '::ffff:172.18.0.4', 'fd12:3456::1', 'fc00::1'])
    assert.equal(isInternalAddress(a), true, a);
});

test('outside addresses and garbage are refused', () => {
  for (const a of ['8.8.8.8', '45.93.95.182', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '2001:db8::1', '::ffff:8.8.8.8', '300.1.1.1', '', undefined, null, 'localhost', '127.0.0.1.evil.com'])
    assert.equal(isInternalAddress(a), false, String(a));
});

const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });

test('the key is required, and a missing server key switches the endpoint off', () => {
  assert.deepEqual(checkNotifyRequest(req('172.18.0.4', { 'x-notify-key': 'k1' }), 'k1'), { ok: true });
  assert.equal(checkNotifyRequest(req('172.18.0.4', {}), 'k1').status, 401);
  assert.equal(checkNotifyRequest(req('172.18.0.4', { 'x-notify-key': 'wrong' }), 'k1').status, 401);
  assert.equal(checkNotifyRequest(req('172.18.0.4', { 'x-notify-key': '' }), 'k1').status, 401);
  assert.equal(checkNotifyRequest(req('172.18.0.4', { 'x-notify-key': 'k1' }), '').status, 404);
});

test('the right key from outside is still refused', () => {
  assert.equal(checkNotifyRequest(req('8.8.8.8', { 'x-notify-key': 'k1' }), 'k1').status, 403);
});

test('a request that came through a proxy is refused even from a private address', () => {
  for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto'])
    assert.equal(checkNotifyRequest(req('127.0.0.1', { 'x-notify-key': 'k1', [h]: '1.2.3.4' }), 'k1').status, 403, h);
});
