// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The side-effect counter of the fault tests and the agents browser suite
 * (`tests/config/test-counter.mjs`): it counts every write, never hides a
 * second one, and answers the test on `/__counter`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WRITER_HEADER, createCounter, startCounter } from '../../tests/config/test-counter.mjs';

test('every write counts: two writes for one key are 2, never 1', () => {
  const counter = createCounter();
  assert.equal(counter.count('k'), 0);
  assert.equal(counter.write('k'), 1);
  assert.equal(counter.write('k', 'again'), 2);
  assert.equal(counter.write('other', 'x'), 1);
  assert.deepEqual(counter.read('k'), { key: 'k', count: 2, values: ['again'] });
  assert.deepEqual(counter.snapshot(), {
    total: 3,
    counters: { k: { count: 2, values: ['again'] }, other: { count: 1, values: ['x'] } }
  });
  counter.reset();
  assert.deepEqual(counter.snapshot(), { total: 0, counters: {} });
});

test('what a caller gets is a copy: changing it does not change the counter', () => {
  const counter = createCounter();
  counter.write('k', 'kept');
  counter.read('k').values.push('forged');
  counter.snapshot().counters.k.values.push('forged');
  assert.deepEqual(counter.read('k').values, ['kept']);
});

test('over HTTP: write, read, the overview for the test, and reset', async t => {
  const started = await startCounter();
  t.after(() => started.close());
  const call = async (method, pathname, body) => {
    const response = await fetch(`${started.url}${pathname}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return [response.status, await response.json()];
  };

  assert.deepEqual(await call('POST', '/count/order-1'), [200, { key: 'order-1', count: 1 }]);
  assert.deepEqual(await call('POST', '/count/order-1', { value: 'paid' }), [
    200,
    { key: 'order-1', count: 2 }
  ]);
  assert.deepEqual(await call('GET', '/count/order-1'), [
    200,
    { key: 'order-1', count: 2, values: ['paid'] }
  ]);
  assert.deepEqual(await call('GET', '/__counter'), [
    200,
    { total: 2, counters: { 'order-1': { count: 2, values: ['paid'] } } }
  ]);
  // The counter in this process is the same one.
  assert.equal(started.counter.count('order-1'), 2);

  assert.deepEqual(await call('POST', '/__counter/reset'), [200, { total: 0, counters: {} }]);
  assert.deepEqual(await call('GET', '/count/order-1'), [
    200,
    { key: 'order-1', count: 0, values: [] }
  ]);
});

test('a write can name the process it comes from; the answers of the counter do not change', async t => {
  const started = await startCounter();
  t.after(() => started.close());
  const write = async (key, writer) => {
    const response = await fetch(`${started.url}/count/${key}`, {
      method: 'POST',
      headers: writer === undefined ? {} : { [WRITER_HEADER]: writer }
    });
    return response.json();
  };

  assert.deepEqual(await write('k', '4711'), { key: 'k', count: 1 });
  assert.deepEqual(await write('k'), { key: 'k', count: 2 });
  assert.deepEqual(await write('k', '4712'), { key: 'k', count: 3 });
  // Not a plain name: the write counts, and nobody is put down as its writer.
  assert.deepEqual(await write('k', 'a b/c'), { key: 'k', count: 4 });
  assert.deepEqual(await write('other', '4711'), { key: 'other', count: 1 });

  assert.deepEqual(started.counter.writers('k'), ['4711', '4712']);
  assert.deepEqual(started.counter.writers('other'), ['4711']);
  assert.deepEqual(started.counter.writers('never-written'), []);
  started.counter.writers('k').push('forged');
  assert.deepEqual(started.counter.writers('k'), ['4711', '4712'], 'a copy, as the rest');
  // What a tool and a browser spec read stays as it was.
  assert.deepEqual(started.counter.read('k'), { key: 'k', count: 4, values: [] });
  assert.deepEqual(started.counter.snapshot().counters.other, { count: 1, values: [] });

  started.counter.reset();
  assert.deepEqual(started.counter.writers('k'), []);
});

test('over HTTP: a bad key, a bad body, another method and another path are refused', async t => {
  const started = await startCounter();
  t.after(() => started.close());
  const status = async (method, pathname, body) =>
    (await fetch(`${started.url}${pathname}`, { method, body })).status;

  assert.equal(await status('POST', '/count/a%2Fb'), 400);
  assert.equal(await status('POST', '/count/%E0%A4%A'), 400);
  assert.equal(await status('GET', `/count/${'x'.repeat(65)}`), 400);
  assert.equal(await status('POST', '/count/k', 'not json'), 400);
  assert.equal(await status('DELETE', '/count/k'), 405);
  assert.equal(await status('GET', '/elsewhere'), 404);
  assert.equal(await status('GET', '/__counter/reset'), 404);
  assert.deepEqual(started.counter.snapshot(), { total: 0, counters: {} }, 'nothing was counted');
});

test('handle() leaves a request that is not the counter’s to the server around it', async () => {
  const counter = createCounter();
  const handled = await counter.handle({ url: '/__status', method: 'GET' }, {});
  assert.equal(handled, false);
});
