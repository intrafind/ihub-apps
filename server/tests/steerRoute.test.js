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
 * `DELETE /api/runs/{runId}/human-events/{id}` answers 204, 404, 409
 * `STEER_ALREADY_APPLIED` or 503 while the answer ends, and 403 to anyone but
 * the owner; `GET /api/chats/{chatId}` lists what waits (`pending`, `maySteer`)
 * for whoever may read the chat, with the remove action for its owner only.
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

describe('the steering contract across the end of an answer and other runs', () => {
  it('answers 503 while the answer ends and its leftover is decided, then 409 once it is sent', async () => {
    const run = await h.seedUserRun();
    const { body } = await send(run.runId, { message: 'Then this', mode: 'afterwards' });
    // The answer let go of its chat: what waited is taken, not settled yet.
    const taken = h.steering.closeSteering(run.runId);
    const ending = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, {
      user: USERS.owner
    });
    assert.equal(ending.status, 503, JSON.stringify(ending.body));
    assert.equal(ending.body.code, 'SERVICE_UNAVAILABLE');
    assert.match(ending.headers['content-type'], /application\/problem\+json/);
    h.steering.settleSent(run.runId, taken, 'chat-next-run');
    const sent = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, {
      user: USERS.owner
    });
    assert.equal(sent.status, 409);
    assert.equal(sent.body.code, 'STEER_ALREADY_APPLIED');
  });

  it('removes a message that waits in the next turn under the run it was sent to', async () => {
    const run = await h.seedUserRun();
    const next = await h.seedUserRun();
    const first = await send(run.runId, { message: 'Summarise', mode: 'afterwards' });
    const behind = await send(run.runId, { message: 'One line' });
    const [asked, ...rest] = h.steering.closeSteering(run.runId);
    h.steering.settleSent(run.runId, [asked], next.runId);
    h.steering.moveSteers(run.runId, rest, next.runId);
    assert.deepEqual(
      h.steering.pendingSteers(next.runId).map(p => [p.id, p.runId]),
      [[behind.body.id, run.runId]],
      'listed under the run it was sent to'
    );
    const removed = await h.send('delete', `${steerPath(run.runId)}/${behind.body.id}`, {
      user: USERS.owner
    });
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    assert.deepEqual(h.steering.takeSteers(next.runId), [], 'never read by the next turn');
    const question = await h.send('delete', `${steerPath(run.runId)}/${first.body.id}`, {
      user: USERS.owner
    });
    assert.equal(question.status, 409, 'the next turn’s question cannot be removed');
  });

  it('answers 409 under the original run once the next turn read a moved message', async () => {
    const run = await h.seedUserRun();
    const next = await h.seedUserRun();
    await send(run.runId, { message: 'Summarise', mode: 'afterwards' });
    const behind = await send(run.runId, { message: 'One line' });
    const [asked, ...rest] = h.steering.closeSteering(run.runId);
    h.steering.settleSent(run.runId, [asked], next.runId);
    h.steering.moveSteers(run.runId, rest, next.runId);
    assert.deepEqual(
      h.steering.takeSteers(next.runId).map(s => s.id),
      [behind.body.id]
    );
    const res = await h.send('delete', `${steerPath(run.runId)}/${behind.body.id}`, {
      user: USERS.owner
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'STEER_ALREADY_APPLIED');
  });

  it('refuses mode afterwards with 400 for a run that is not a chat answer, and takes a steer', async () => {
    const run = await h.seedUserRun(USERS.owner, { kind: 'workflow', withChat: false });
    const later = await send(run.runId, { message: 'Then mail it', mode: 'afterwards' });
    assert.equal(later.status, 400, JSON.stringify(later.body));
    assert.equal(later.body.code, 'BAD_REQUEST');
    assert.deepEqual(h.steering.pendingSteers(run.runId), [], 'nothing queued');
    const now = await send(run.runId, { message: 'Use EUR' });
    assert.equal(now.status, 200);
    assert.equal(now.body.effect, 'steer_queued');
  });

  it('drops what a run that is not a chat answer did not read when it ends', async () => {
    const run = await h.seedUserRun(USERS.owner, { kind: 'workflow', withChat: false });
    const { body } = await send(run.runId, { message: 'Too late for the last step' });
    h.runLog.endRun(run.runId, { status: 'completed' });
    assert.deepEqual(h.steering.pendingSteers(run.runId), []);
    const res = await h.send('delete', `${steerPath(run.runId)}/${body.id}`, {
      user: USERS.owner
    });
    assert.equal(res.status, 404, 'dropped: nothing waits any more');
    const after = await send(run.runId, { message: 'After the end' });
    assert.equal(after.body.id, undefined, 'no running answer takes it');
  });
});

describe('GET /api/chats/{chatId}: what waits for the running answer', () => {
  let configCache;
  before(async () => {
    ({ default: configCache } = await import('../configCache.js'));
    const { default: registerChatRoutes } = await import('../routes/chats.js');
    registerChatRoutes(h.extra);
  });
  after(() => {
    configCache.setCacheEntry('config/features.json', {});
  });

  /** A running chat of the owner with one message waiting for its answer. */
  async function runningChat() {
    const run = await h.seedUserRun();
    const { getChatRepository } = await import('../services/chat/ChatRepository.js');
    await getChatRepository().updateChat(run.chatId, { activeRunId: run.runId, status: 'running' });
    const sent = await send(run.runId, { message: 'Use EUR' });
    assert.equal(sent.status, 200);
    return { ...run, steerId: sent.body.id };
  }

  it('lists it with its remove action and maySteer for the owner only', async () => {
    configCache.setCacheEntry('config/features.json', { steering: true });
    const chat = await runningChat();
    const owner = await h.send('get', `/api/chats/${chat.chatId}`, { user: USERS.owner });
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    assert.equal(owner.body.maySteer, true);
    assert.deepEqual(owner.body.pending, [
      {
        id: chat.steerId,
        runId: chat.runId,
        kind: 'steer',
        text: 'Use EUR',
        labelKey: 'chat.pending.steer',
        actions: ['remove']
      }
    ]);

    // An admin reads the chat (audited elsewhere) but never steers it.
    const admin = await h.send('get', `/api/chats/${chat.chatId}`, { user: USERS.admin });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.body.maySteer, false);
    assert.deepEqual(
      admin.body.pending.map(p => [p.id, p.actions]),
      [[chat.steerId, []]]
    );

    const other = await h.send('get', `/api/chats/${chat.chatId}`, { user: USERS.otherUser });
    assert.equal(other.status, 404);
    assert.equal(other.body.pending, undefined);
  });

  it('sends neither field with the feature off', async () => {
    configCache.setCacheEntry('config/features.json', {});
    const chat = await runningChat();
    const owner = await h.send('get', `/api/chats/${chat.chatId}`, { user: USERS.owner });
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    assert.equal('pending' in owner.body, false);
    assert.equal('maySteer' in owner.body, false);
  });
});
