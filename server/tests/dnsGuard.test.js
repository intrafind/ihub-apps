/**
 * DNS guard specs — see server/utils/dnsGuard.js.
 *
 * libuv runs at most half of its threadpool as getaddrinfo work, so a hung
 * lookup for an unreachable model endpoint blocked one of two slots for the
 * resolver timeout and every other outbound request queued behind it. The
 * guard shares lookups per hostname, bounds the wait and remembers failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedLookup, isDnsFailure, dnsTimeoutError } from '../utils/dnsGuard.js';

/** A fake resolver whose callbacks we release by hand. */
function fakeResolver() {
  const pending = [];
  const inner = (hostname, options, cb) => {
    pending.push({ hostname, options, cb });
  };
  return {
    inner,
    pending,
    answer: (i, err, address = '10.0.0.1', family = 4) => pending[i].cb(err, address, family)
  };
}

const lookup = (guard, host, opts = {}) =>
  new Promise((resolve, reject) =>
    guard(host, opts, (err, address, family) => (err ? reject(err) : resolve({ address, family })))
  );

test('concurrent lookups of one hostname share a single getaddrinfo call', async () => {
  const r = fakeResolver();
  const guard = createGuardedLookup({ inner: r.inner, timeoutMs: 0, negativeTtlMs: 0 });
  const a = lookup(guard, 'vllm.corp.test');
  const b = lookup(guard, 'vllm.corp.test');
  const c = lookup(guard, 'other.corp.test');
  assert.equal(r.pending.length, 2, 'one call per distinct hostname');
  r.answer(0, null, '10.1.1.1');
  r.answer(1, null, '10.2.2.2');
  assert.deepEqual(await a, { address: '10.1.1.1', family: 4 });
  assert.deepEqual(await b, { address: '10.1.1.1', family: 4 });
  assert.deepEqual(await c, { address: '10.2.2.2', family: 4 });
  assert.equal(guard.stats().shared, 1);
});

test('a lookup that exceeds the timeout fails the caller with a getaddrinfo-shaped error', async () => {
  const r = fakeResolver();
  const guard = createGuardedLookup({ inner: r.inner, timeoutMs: 20, negativeTtlMs: 0 });
  await assert.rejects(lookup(guard, 'vllm.corp.test'), err => {
    assert.equal(err.code, 'EAI_TIMEOUT');
    assert.equal(err.syscall, 'getaddrinfo');
    assert.equal(err.hostname, 'vllm.corp.test');
    assert.ok(isDnsFailure(err));
    return true;
  });
  assert.equal(guard.stats().timeouts, 1);
  // The OS answer arriving later must not throw or re-invoke the caller.
  r.answer(0, null, '10.1.1.1');
});

test('a failed hostname is remembered and later requests fail immediately without a new lookup', async () => {
  let now = 1_000;
  const r = fakeResolver();
  const guard = createGuardedLookup({
    inner: r.inner,
    timeoutMs: 0,
    negativeTtlMs: 30_000,
    now: () => now
  });
  const first = lookup(guard, 'vllm.corp.test');
  const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND vllm.corp.test'), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: 'vllm.corp.test'
  });
  r.answer(0, enotfound);
  await assert.rejects(first, /ENOTFOUND/);

  now += 10_000;
  await assert.rejects(lookup(guard, 'vllm.corp.test'), /ENOTFOUND/);
  assert.equal(r.pending.length, 1, 'no second getaddrinfo while the failure is remembered');
  assert.equal(guard.stats().negativeHits, 1);

  now += 30_000; // entry expired: the host is looked up again
  const retry = lookup(guard, 'vllm.corp.test');
  assert.equal(r.pending.length, 2);
  r.answer(1, null, '10.1.1.1');
  assert.deepEqual(await retry, { address: '10.1.1.1', family: 4 });
});

test('a late success after a timeout clears the negative entry', async () => {
  const r = fakeResolver();
  const guard = createGuardedLookup({ inner: r.inner, timeoutMs: 20, negativeTtlMs: 30_000 });
  await assert.rejects(lookup(guard, 'slow.corp.test'), /EAI_TIMEOUT/);
  assert.equal(guard.stats().negative, 1);
  r.answer(0, null, '10.1.1.1'); // the OS eventually resolved it
  assert.equal(guard.stats().negative, 0);
  const next = lookup(guard, 'slow.corp.test');
  assert.equal(r.pending.length, 2, 'a fresh lookup is issued again');
  r.answer(1, null, '10.1.1.1');
  await next;
});

test('IP literals bypass the guard entirely', async () => {
  const r = fakeResolver();
  const guard = createGuardedLookup({ inner: r.inner, timeoutMs: 0, negativeTtlMs: 30_000 });
  const p = lookup(guard, '10.255.255.1');
  assert.equal(r.pending[0].hostname, '10.255.255.1');
  r.answer(0, null, '10.255.255.1');
  await p;
  assert.equal(guard.stats().lookups, 0, 'not counted, not cached');
});

test('the `all: true` form and the callback-only form are supported', async () => {
  const r = fakeResolver();
  const guard = createGuardedLookup({ inner: r.inner, timeoutMs: 0, negativeTtlMs: 0 });
  const all = new Promise((resolve, reject) =>
    guard('multi.corp.test', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)))
  );
  const one = new Promise((resolve, reject) =>
    guard('multi.corp.test', (err, addr) => (err ? reject(err) : resolve(addr)))
  );
  assert.equal(r.pending.length, 2, '`all` and single-address lookups are separate calls');
  r.pending[0].cb(null, [{ address: '10.1.1.1', family: 4 }]);
  r.pending[1].cb(null, '10.1.1.1', 4);
  assert.deepEqual(await all, [{ address: '10.1.1.1', family: 4 }]);
  assert.equal(await one, '10.1.1.1');
});

test('isDnsFailure recognises node-fetch wrappers and cause chains', () => {
  const fetchErr = Object.assign(
    new Error('request to http://x failed, reason: getaddrinfo ENOTFOUND x'),
    {
      code: 'ENOTFOUND',
      erroredSysCall: 'getaddrinfo'
    }
  );
  assert.ok(isDnsFailure(fetchErr));
  assert.ok(isDnsFailure(new Error('wrapped', { cause: dnsTimeoutError('x', 5000) })));
  assert.equal(isDnsFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), false);
  assert.equal(isDnsFailure(null), false);
});
