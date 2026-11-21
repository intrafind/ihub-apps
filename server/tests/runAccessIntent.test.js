// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Run access by intent (#3785, #3191): who may read, stop, send a message
 * into, rate or delete a run, asked of the real routes.
 *
 * The table below is the documented status of every caller for every intent.
 * Each cell is one request against `server/routes/runs.js` with the real access
 * check, the real chat repository and a run started the way a chat turn starts
 * it; a stop or a delete changes its run, so every cell gets a run of its own.
 *
 * The second half asks `runAccess` directly for what no route reaches yet
 * (`rerun`, the run-level `answer`) and for the rule the whole file rests on:
 * a check without an intent throws.
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

/** How each intent is asked of the routes. */
const REQUESTS = {
  read: runId => ['get', `/api/runs/${runId}`],
  stop: runId => ['post', `/api/runs/${runId}/human-events`, { kind: 'stop' }],
  steer: runId => [
    'post',
    `/api/runs/${runId}/human-events`,
    { kind: 'steer', message: 'Use the newer report' }
  ],
  feedback: runId => ['post', `/api/runs/${runId}/human-events`, { kind: 'feedback', rating: 1 }],
  delete: runId => ['delete', `/api/runs/${runId}`]
};

const OK = { status: 200 };
const FORBIDDEN = { status: 403, code: 'FORBIDDEN' };
const STEER_FORBIDDEN = { status: 403, code: 'RUN_STEER_FORBIDDEN' };

/**
 * The documented status of each caller per intent. `run` says whose run the
 * caller addresses: a signed-in user's, or an anonymous visitor's.
 */
const MATRIX = [
  {
    caller: 'the owner',
    run: 'user',
    as: () => ({ user: USERS.owner }),
    expect: { read: OK, stop: OK, steer: OK, feedback: OK, delete: OK }
  },
  {
    caller: 'another user',
    run: 'user',
    as: () => ({ user: USERS.otherUser }),
    expect: {
      read: FORBIDDEN,
      stop: FORBIDDEN,
      steer: STEER_FORBIDDEN,
      feedback: FORBIDDEN,
      delete: FORBIDDEN
    }
  },
  {
    caller: 'an admin who is not the owner',
    run: 'user',
    as: () => ({ user: USERS.admin }),
    expect: { read: OK, stop: OK, steer: STEER_FORBIDDEN, feedback: FORBIDDEN, delete: OK }
  },
  {
    caller: 'an anonymous caller on a user run',
    run: 'user',
    as: () => ({}),
    expect: {
      read: FORBIDDEN,
      stop: FORBIDDEN,
      steer: STEER_FORBIDDEN,
      feedback: FORBIDDEN,
      delete: FORBIDDEN
    }
  },
  {
    caller: 'the anonymous visitor with the guest cookie',
    run: 'guest',
    as: run => ({ cookie: run.cookie }),
    expect: { read: OK, stop: OK, steer: OK, feedback: OK, delete: OK }
  },
  {
    caller: 'an anonymous caller without the guest cookie',
    run: 'guest',
    as: () => ({}),
    expect: {
      read: OK,
      stop: FORBIDDEN,
      steer: STEER_FORBIDDEN,
      feedback: FORBIDDEN,
      delete: FORBIDDEN
    }
  },
  {
    caller: "an anonymous caller with another browser's guest cookie",
    run: 'guest',
    as: () => ({ cookie: `${h.chatOwner.GUEST_COOKIE}=${h.chatOwner.mintGuestId()}` }),
    expect: {
      read: OK,
      stop: FORBIDDEN,
      steer: STEER_FORBIDDEN,
      feedback: FORBIDDEN,
      delete: FORBIDDEN
    }
  },
  {
    caller: 'a signed-in user who holds only the id of an anonymous run',
    run: 'guest',
    as: () => ({ user: USERS.otherUser }),
    expect: {
      read: OK,
      stop: FORBIDDEN,
      steer: STEER_FORBIDDEN,
      feedback: FORBIDDEN,
      delete: FORBIDDEN
    }
  },
  {
    caller: 'an admin on an anonymous run',
    run: 'guest',
    as: () => ({ user: USERS.admin }),
    expect: { read: OK, stop: OK, steer: STEER_FORBIDDEN, feedback: FORBIDDEN, delete: OK }
  }
];

describe('run access: the documented status of every caller for every intent', () => {
  for (const row of MATRIX) {
    for (const [intent, expected] of Object.entries(row.expect)) {
      it(`${row.caller}: ${intent} answers ${expected.status}${expected.code ? ` ${expected.code}` : ''}`, async () => {
        const run = row.run === 'guest' ? await h.seedGuestRun() : await h.seedUserRun();
        const [method, url, body] = REQUESTS[intent](run.runId);
        const res = await h.send(method, url, row.as(run), body);
        assert.equal(res.status, expected.status, JSON.stringify(res.body));
        if (expected.code) {
          assert.match(res.headers['content-type'], /^application\/problem\+json/);
          assert.equal(res.body.code, expected.code);
        }
        // A refused message is not queued for the loop, and a refused event
        // is not on the run's ledger.
        if (intent === 'steer') {
          const queued = h.steering.takeSteers(run.runId);
          assert.equal(queued.length, expected.status === 200 ? 1 : 0);
        }
        if (expected.status !== 200 && intent !== 'read' && intent !== 'delete') {
          const events = await h.runLog.readEvents(run.runId);
          assert.equal(
            events.some(event => event.type === 'human/event'),
            false,
            'a refused human event must not be recorded'
          );
        }
      });
    }
  }

  it('answers 404 for a run nobody recorded, whoever asks and whatever for', async () => {
    for (const caller of [{ user: USERS.owner }, { user: USERS.admin }, {}]) {
      for (const intent of Object.keys(REQUESTS)) {
        const [method, url, body] = REQUESTS[intent]('chat-0000000000000000000000000000dead');
        const res = await h.send(method, url, caller, body);
        assert.equal(res.status, 404, `${intent}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.code, 'NOT_FOUND');
      }
    }
  });
});

describe('run access: what an admin does to somebody else’s run is on record', () => {
  it('writes an admin stop to the audit log, and the owner’s own stop not', async () => {
    const run = await h.seedUserRun();
    await h.send(
      'post',
      `/api/runs/${run.runId}/human-events`,
      { user: USERS.admin },
      { kind: 'stop' }
    );
    const entries = await h.auditEntriesFor(run.runId);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].action, 'update');
    assert.equal(entries[0].actor.id, USERS.admin.id);
    assert.equal(entries[0].result, 'success');
    assert.equal(entries[0].summary, 'Admin stopped a run that is not their own');
    assert.equal(entries[0].details.event, 'stop');
    assert.equal(entries[0].details.effect, 'chat_aborted');
    assert.equal(entries[0].details.stoppedSomething, true);
    assert.equal(entries[0].details.principalId, run.principalId);

    const own = await h.seedUserRun();
    const res = await h.send(
      'post',
      `/api/runs/${own.runId}/human-events`,
      { user: USERS.owner },
      { kind: 'stop' }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await h.auditEntriesFor(own.runId), []);
  });

  it('says in the audit entry when the stop reached a run that was no longer running', async () => {
    const run = await h.seedUserRun();
    h.runLog.endRun(run.runId, { status: 'completed', finishReason: 'stop' });
    const res = await h.send(
      'post',
      `/api/runs/${run.runId}/human-events`,
      { user: USERS.admin },
      { kind: 'stop' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.effect, undefined, 'nothing was stopped');
    const entries = await h.auditEntriesFor(run.runId);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(
      entries[0].summary,
      'Admin sent a stop to a run that is not their own; nothing was running'
    );
    assert.equal(entries[0].details.effect, null);
    assert.equal(entries[0].details.stoppedSomething, false);
  });

  it('writes an admin delete to the audit log', async () => {
    const run = await h.seedUserRun();
    const res = await h.send('delete', `/api/runs/${run.runId}`, { user: USERS.admin });
    assert.equal(res.status, 200);
    const entries = await h.auditEntriesFor(run.runId);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].action, 'delete');
    assert.equal(entries[0].summary, 'Admin deleted a run that is not their own');
    assert.equal(entries[0].actor.id, USERS.admin.id);
  });

  it('does not audit an admin who stops a run of their own', async () => {
    const run = await h.seedUserRun(USERS.admin);
    const res = await h.send(
      'post',
      `/api/runs/${run.runId}/human-events`,
      { user: USERS.admin },
      { kind: 'stop' }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await h.auditEntriesFor(run.runId), []);
  });
});

describe('run access: an intent is mandatory', () => {
  const missing = [undefined, null, '', 'write', 'READ', 'constructor', '__proto__', 5, {}];

  it('throws for a run check without a known intent, before anything is read', async () => {
    const run = await h.seedUserRun();
    const { authorizeRun, authorizeLedgerRun, authorizeExecution } = h.runAccess;
    await assert.rejects(authorizeRun(run.runId, USERS.owner), TypeError);
    await assert.rejects(authorizeRun(run.runId, USERS.admin, {}), TypeError);
    for (const intent of missing) {
      for (const check of [authorizeRun, authorizeLedgerRun, authorizeExecution]) {
        await assert.rejects(
          check(run.runId, USERS.admin, { intent }),
          TypeError,
          `${check.name} with intent ${JSON.stringify(intent)}`
        );
      }
    }
  });

  it('throws for an interaction check without a known intent', async () => {
    const run = await h.seedUserRun();
    const interaction = { id: 'i1', runId: run.runId, source: { principalId: run.principalId } };
    const { authorizeInteraction } = h.runAccess;
    await assert.rejects(authorizeInteraction(interaction, USERS.owner), TypeError);
    for (const intent of [...missing, 'stop', 'steer']) {
      await assert.rejects(
        authorizeInteraction(interaction, USERS.admin, { intent }),
        TypeError,
        `intent ${JSON.stringify(intent)}`
      );
    }
  });

  it('knows exactly the documented intents', () => {
    assert.deepEqual(
      [...h.runAccess.RUN_INTENTS],
      ['read', 'stop', 'delete', 'feedback', 'answer', 'steer', 'rerun']
    );
    assert.deepEqual([...h.runAccess.INTERACTION_INTENTS], ['read', 'answer', 'cancel']);
  });
});

describe('run access: the intents no route asks for yet', () => {
  /** An anonymous principal that carries a guest identity, as a request leaves it. */
  function guest(cookie) {
    const user = { id: 'anonymous', groups: ['anonymous'] };
    h.chatOwner.setGuestId(user, cookie.split('=')[1]);
    return user;
  }

  it('lets only the owner re-run or answer, never an admin', async () => {
    const run = await h.seedUserRun();
    const { authorizeRun } = h.runAccess;
    for (const intent of ['rerun', 'answer']) {
      assert.equal((await authorizeRun(run.runId, USERS.owner, { intent })).ok, true, intent);
      for (const user of [USERS.otherUser, USERS.admin, null]) {
        assert.deepEqual(
          await authorizeRun(run.runId, user, { intent }),
          { ok: false, status: 403 },
          `${intent} as ${user?.id ?? 'anonymous'}`
        );
      }
    }
  });

  it('lets only the guest with the cookie re-run or answer an anonymous run', async () => {
    const run = await h.seedGuestRun();
    const { authorizeRun } = h.runAccess;
    for (const intent of ['rerun', 'answer']) {
      assert.equal((await authorizeRun(run.runId, guest(run.cookie), { intent })).ok, true);
      const strangers = [
        { id: 'anonymous', groups: ['anonymous'] },
        guest(`x=${h.chatOwner.mintGuestId()}`),
        USERS.otherUser,
        USERS.admin
      ];
      for (const user of strangers) {
        assert.equal((await authorizeRun(run.runId, user, { intent })).ok, false, intent);
      }
    }
  });
});

describe('run access: a message into a run needs the write right on its chat', () => {
  /** A run recorded for Alice on a chat that is stored for Bob. */
  async function seedRunOnSomebodyElsesChat() {
    const bob = await h.chatOwner.resolveChatOwner(USERS.otherUser, { mode: 'default' });
    const chatId = await h.seedChat(bob.id);
    const { runId } = await h.runLog.startRun({
      kind: 'chat',
      user: USERS.owner,
      refs: { chatId, appId: 'chat' }
    });
    // The run's summary is written behind the start. It is the record the
    // execution check reads, so the cases below ask once it is stored: before
    // that only the ledger check could answer, and the question would be easier
    // than the one a request asks.
    await h.runLog.flush();
    return { runId, chatId };
  }

  it('refuses the run’s principal when the chat is stored for somebody else', async () => {
    const { runId } = await seedRunOnSomebodyElsesChat();
    const { authorizeRun } = h.runAccess;
    for (const intent of ['steer', 'rerun']) {
      assert.deepEqual(
        await authorizeRun(runId, USERS.owner, { intent }),
        { ok: false, status: 403 },
        intent
      );
    }
    // What does not speak in the chat stays with the principal.
    assert.equal((await authorizeRun(runId, USERS.owner, { intent: 'stop' })).ok, true);
    assert.equal((await authorizeRun(runId, USERS.owner, { intent: 'read' })).ok, true);
    // Owning the chat is not owning the run.
    assert.equal((await authorizeRun(runId, USERS.otherUser, { intent: 'steer' })).ok, false);
  });

  it('is not overruled by the run’s summary: the execution record keeps the chat rule', async () => {
    const { runId } = await seedRunOnSomebodyElsesChat();
    const { authorizeRun, authorizeLedgerRun, authorizeExecution } = h.runAccess;
    // The summary names Alice as the owner, so the execution record knows her.
    const read = await authorizeExecution(runId, USERS.owner, { intent: 'read' });
    assert.equal(read?.ok, true, 'the summary of the run is stored and names its principal');
    for (const intent of ['steer', 'rerun']) {
      assert.deepEqual(
        await authorizeLedgerRun(runId, USERS.owner, { intent }),
        { ok: false, status: 403 },
        `${intent}: the run’s own record refuses`
      );
      assert.equal(
        await authorizeExecution(runId, USERS.owner, { intent }),
        null,
        `${intent}: the execution record does not grant what the chat refuses`
      );
      assert.deepEqual(
        await authorizeRun(runId, USERS.owner, { intent }),
        { ok: false, status: 403 },
        `${intent}: and the refusal stands`
      );
    }
  });

  it('answers the route with RUN_STEER_FORBIDDEN and queues nothing', async () => {
    const { runId } = await seedRunOnSomebodyElsesChat();
    const res = await h.send(
      'post',
      `/api/runs/${runId}/human-events`,
      { user: USERS.owner },
      { kind: 'steer', message: 'Use the newer report' }
    );
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'RUN_STEER_FORBIDDEN');
    assert.deepEqual(h.steering.takeSteers(runId), []);
    const events = await h.runLog.readEvents(runId);
    assert.equal(
      events.some(event => event.type === 'human/event'),
      false,
      'a refused message must not be recorded'
    );
  });

  it('lets no execution record speak for the guest of an anonymous run', async () => {
    const run = await h.seedGuestRun();
    await h.runLog.flush();
    const { authorizeRun } = h.runAccess;
    for (const intent of ['stop', 'delete', 'steer', 'feedback', 'answer', 'rerun']) {
      assert.deepEqual(
        await authorizeRun(run.runId, USERS.otherUser, { intent }),
        { ok: false, status: 403 },
        intent
      );
    }
  });

  it('leaves a run without a stored chat to its principal', async () => {
    const run = await h.seedUserRun(USERS.owner, { withChat: false });
    const res = await h.send(
      'post',
      `/api/runs/${run.runId}/human-events`,
      { user: USERS.owner },
      { kind: 'steer', message: 'Shorter, please' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.effect, 'steer_queued');
  });

  it('gives an anonymous run without a stored chat no owner: only an admin stops it', async () => {
    const { runId } = await h.runLog.startRun({ kind: 'chat', user: null, refs: {} });
    const anonymous = { id: 'anonymous', groups: ['anonymous'] };
    const { authorizeRun } = h.runAccess;
    assert.equal((await authorizeRun(runId, anonymous, { intent: 'read' })).ok, true);
    for (const intent of ['stop', 'delete', 'steer', 'feedback', 'answer', 'rerun']) {
      assert.equal((await authorizeRun(runId, anonymous, { intent })).ok, false, intent);
    }
    const admin = await authorizeRun(runId, USERS.admin, { intent: 'stop' });
    assert.equal(admin.ok, true);
    assert.equal(admin.viaAdmin, true);
  });
});
