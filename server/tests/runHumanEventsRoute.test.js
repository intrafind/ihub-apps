// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `POST /api/runs/{runId}/human-events`: the limit on messages sent into a
 * running answer (#3191). 30 per caller and minute; the 31st answers 429 as
 * problem+json. The real limiter of `server/routes/runs.js` counts here, so
 * every case uses a caller of its own.
 *
 * The limit has to hold across the worker processes of one server. That is the
 * work of `ClusterRateLimitStore` (tested in `clusterRateLimitStore.test.js`);
 * what is pinned here is that this route counts through it, under a key of its
 * own, and with which key each caller is counted.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startRunAccessHarness, USERS } from './helpers/runAccessHarness.js';

let h;
let limit;
let ClusterRateLimitStore;
before(async () => {
  h = await startRunAccessHarness();
  ({ limit } = (await import('../middleware/rateLimiting.js')).RUN_STEER_RATE_LIMIT);
  ({ ClusterRateLimitStore } = await import('../utils/clusterRateLimitStore.js'));
});
after(async () => {
  await h.stop();
});

const steer = (runId, caller, message = 'One more thing') =>
  h.send('post', `/api/runs/${runId}/human-events`, caller, { kind: 'steer', message });

describe('the limit on messages into a running answer', () => {
  it('is 30 per minute', () => {
    assert.equal(limit, 30);
  });

  it('answers the 31st message of one caller with 429 as problem+json', async () => {
    const run = await h.seedUserRun(USERS.secondOwner);
    const caller = { user: USERS.secondOwner };
    for (let sent = 1; sent <= limit; sent += 1) {
      const res = await steer(run.runId, caller, `Message ${sent}`);
      assert.equal(res.status, 200, `message ${sent}: ${JSON.stringify(res.body)}`);
    }
    const before = (await h.runLog.readEvents(run.runId)).length;

    const refused = await steer(run.runId, caller, 'Message 31');
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.match(refused.headers['content-type'], /^application\/problem\+json/);
    assert.equal(refused.body.code, 'RATE_LIMITED');
    assert.equal(refused.body.status, 429);
    assert.equal(refused.body.type, 'urn:ihub:problem:RATE_LIMITED');
    assert.ok(Number(refused.headers['retry-after']) > 0, 'Retry-After says how long to wait');
    assert.equal((await h.runLog.readEvents(run.runId)).length, before, 'nothing was recorded');

    // The limit is on messages only: the run can still be stopped and rated.
    const rated = await h.send('post', `/api/runs/${run.runId}/human-events`, caller, {
      kind: 'feedback',
      rating: 1
    });
    assert.equal(rated.status, 200, JSON.stringify(rated.body));
    const stopped = await h.send('post', `/api/runs/${run.runId}/human-events`, caller, {
      kind: 'stop'
    });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));

    // And it is this caller's count: the next user sends as before.
    const other = await h.seedUserRun(USERS.owner);
    assert.equal((await steer(other.runId, { user: USERS.owner })).status, 200);
  });

  it('counts refused messages too, so it also bounds guessing at run ids', async () => {
    const run = await h.seedUserRun(USERS.owner);
    const caller = { user: USERS.otherUser };
    for (let sent = 1; sent <= limit; sent += 1) {
      const res = await steer(run.runId, caller);
      assert.equal(res.status, 403, `message ${sent}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'RUN_STEER_FORBIDDEN');
    }
    const refused = await steer(run.runId, caller);
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'RATE_LIMITED');
  });

  it('counts through the store the workers of one server share, per user', async t => {
    const increment = t.mock.method(ClusterRateLimitStore.prototype, 'increment');
    const run = await h.seedUserRun(USERS.owner);
    const caller = { user: USERS.owner };

    assert.equal((await steer(run.runId, caller)).status, 200);
    assert.equal(increment.mock.callCount(), 1, 'one message, one count in the shared store');
    const [call] = increment.mock.calls;
    assert.deepEqual(call.arguments, [`user:${USERS.owner.id}`]);
    // A count of its own: no other limiter adds to it or is slowed by it.
    assert.equal(call.this.storeId, 'run steer');
    assert.equal(call.this.windowMs, 60 * 1000);

    // A stop and a rating are not counted at all.
    for (const body of [{ kind: 'feedback', rating: 1 }, { kind: 'stop' }]) {
      await h.send('post', `/api/runs/${run.runId}/human-events`, caller, body);
    }
    assert.equal(increment.mock.callCount(), 1);
  });

  it('counts a caller who is not signed in per address, whatever cookie they send', async t => {
    const increment = t.mock.method(ClusterRateLimitStore.prototype, 'increment');
    const run = await h.seedGuestRun();
    const other = await h.seedGuestRun();

    // The guest who owns the chat, a caller without a cookie and a second
    // browser session: one address, one count. Dropping the cookie starts none.
    assert.equal((await steer(run.runId, { cookie: run.cookie })).status, 200);
    assert.equal((await steer(run.runId, {})).status, 403);
    assert.equal((await steer(other.runId, { cookie: other.cookie })).status, 200);
    const keys = increment.mock.calls.map(call => call.arguments[0]);
    assert.equal(keys.length, 3);
    assert.match(keys[0], /^ip:/);
    assert.equal(new Set(keys).size, 1, JSON.stringify(keys));
    increment.mock.restore();

    // Three are counted; the 31st message from this address answers 429.
    for (let sent = 4; sent <= limit; sent += 1) {
      const res = await steer(run.runId, {});
      assert.equal(res.status, 403, `message ${sent}: ${JSON.stringify(res.body)}`);
    }
    const refused = await steer(run.runId, { cookie: run.cookie });
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'RATE_LIMITED');
    // A signed-in user at the same address has a count of their own.
    const mine = await h.seedUserRun(USERS.admin);
    assert.equal((await steer(mine.runId, { user: USERS.admin })).status, 200);
  });
});
