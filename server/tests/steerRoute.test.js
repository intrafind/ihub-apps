// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The steering contract of the run routes (#3191): a message for a running
 * answer gets an id, waits in the run's queue, and is removed by its id until
 * the answer reads it.
 *
 * Asked of the real routes over the real access check (`runAccessHarness.js`):
 * `POST /api/runs/{runId}/human-events` answers `{ id, effect }` for a message
 * a running answer took, and nothing of the kind otherwise;
 * `DELETE /api/runs/{runId}/human-events/{id}` answers 204, 404, or 409
 * `STEER_ALREADY_APPLIED`, and 403 to anyone but the owner.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startRunAccessHarness, USERS } from './helpers/runAccessHarness.js';

let h;
before(async () => {
  h = await startRunAccessHarness();
});
after(async () => {
  await h.stop();
});

const steerPath = runId => `/api/runs/${runId}/human-events`;

/** Send a message as the owner of a user run; answers the response. */
function send(runId, body, caller = { user: USERS.owner }) {
  return h.send('post', steerPath(runId), caller, { kind: 'steer', ...body });
}

describe('POST /api/runs/{runId}/human-events with kind steer', () => {
  it('answers 200 with the id of the message and where it went', async () => {
    const run = await h.seedUserRun();
    const res = await send(run.runId, { message: 'Use the 2025 numbers' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.effect, 'steer_queued');
    assert.equal(res.body.runId, run.runId);
    assert.deepEqual(
      h.steering.pendingSteers(run.runId).map(p => [p.id, p.kind, p.text, p.chatId]),
      [[res.body.id, 'steer', 'Use the 2025 numbers', run.chatId]]
    );
    const ledger = await h.runLog.readEvents(run.runId);
    const recorded = ledger.find(e => e.type === 'human/event' && e.data.steerId === res.body.id);
    assert.equal(recorded.data.mode, 'steer');
  });

  it('takes mode afterwards: the message waits for the end of the answer', async () => {
    const run = await h.seedUserRun();
    const res = await send(run.runId, { message: 'Then summarise it', mode: 'afterwards' });
    assert.equal(res.status, 200);
    assert.deepEqual(h.steering.takeSteers(run.runId), [], 'not read at a step');
    assert.deepEqual(
      h.steering.pendingSteers(run.runId).map(p => [p.id, p.kind]),
      [[res.body.id, 'send_after']]
    );
  });

  it('refuses a mode on another kind and an unknown mode with 400', async () => {
    const run = await h.seedUserRun();
    const stop = await h.send(
      'post',
      steerPath(run.runId),
      { user: USERS.owner },
      {
        kind: 'stop',
        mode: 'afterwards'
      }
    );
    assert.equal(stop.status, 400);
    const unknown = await send(run.runId, { message: 'x', mode: 'later' });
    assert.equal(unknown.status, 400);
  });

  it('names no id when no running answer took the message', async () => {
    const run = await h.seedUserRun();
    h.steering.closeSteering(run.runId);
    const res = await send(run.runId, { message: 'Too late' });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, undefined);
    assert.equal(res.body.effect, undefined);
  });
});

describe('DELETE /api/runs/{runId}/human-events/{id}', () => {
  it('removes a waiting message: 204, and it is never read', async () => {
    const run = await h.seedUserRun();
    const { body } = await send(run.runId, { message: 'Skip the appendix' });
    const res = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, {
      user: USERS.owner
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.deepEqual(h.steering.takeSteers(run.runId), []);
    // The ledger says why the message that was sent was never read.
    const ledger = await h.runLog.readEvents(run.runId);
    assert.ok(
      ledger.some(
        e => e.type === 'human/event' && e.data.steerId === body.id && e.data.removed === true
      )
    );
    const again = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, {
      user: USERS.owner
    });
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'NOT_FOUND');
  });

  it('answers 409 STEER_ALREADY_APPLIED for a message the answer read', async () => {
    const run = await h.seedUserRun();
    const { body } = await send(run.runId, { message: 'Use EUR' });
    assert.deepEqual(
      h.steering.takeSteers(run.runId).map(s => s.id),
      [body.id]
    );
    const res = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, {
      user: USERS.owner
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'STEER_ALREADY_APPLIED');
    assert.match(res.headers['content-type'], /application\/problem\+json/);
  });

  it('answers 409 for a message sent as the next turn', async () => {
    const run = await h.seedUserRun();
    const { body } = await send(run.runId, { message: 'Then this', mode: 'afterwards' });
    const leftover = h.steering.closeSteering(run.runId);
    h.steering.settleSent(run.runId, leftover, 'chat-next-run');
    const res = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, {
      user: USERS.owner
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'STEER_ALREADY_APPLIED');
  });

  for (const [caller, as] of [
    ['another user', { user: USERS.otherUser }],
    ['an admin', { user: USERS.admin }]
  ]) {
    it(`refuses ${caller} with 403 and leaves the message queued`, async () => {
      const run = await h.seedUserRun();
      const { body } = await send(run.runId, { message: 'Only mine' });
      const res = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, as);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'RUN_STEER_FORBIDDEN');
      assert.deepEqual(
        h.steering.pendingSteers(run.runId).map(p => p.id),
        [body.id]
      );
    });
  }

  it('removes nothing of another run with an id of this one', async () => {
    const run = await h.seedUserRun();
    const otherRun = await h.seedUserRun();
    const { body } = await send(otherRun.runId, { message: 'Other run' });
    const res = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, {
      user: USERS.owner
    });
    assert.equal(res.status, 404);
    assert.deepEqual(
      h.steering.pendingSteers(otherRun.runId).map(p => p.id),
      [body.id]
    );
  });

  it('refuses an id with characters an id cannot have', async () => {
    const run = await h.seedUserRun();
    const res = await h.send('delete', `${steerPath(run.runId)}/a%20b`, { user: USERS.owner });
    assert.equal(res.status, 400);
  });

  it('lets the guest who owns an anonymous run remove its message, and nobody holding its id', async () => {
    const run = await h.seedGuestRun();
    const sent = await h.send(
      'post',
      steerPath(run.runId),
      { cookie: run.cookie },
      {
        kind: 'steer',
        message: 'Shorter, please'
      }
    );
    assert.equal(sent.status, 200);
    const holder = await h.send('delete', `${steerPath(run.runId)}/${sent.body.id}`, {});
    assert.equal(holder.status, 403);
    const guest = await h.send('delete', `${steerPath(run.runId)}/${sent.body.id}`, {
      cookie: run.cookie
    });
    assert.equal(guest.status, 204);
  });
});
