// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A rating posted to `POST /api/feedback` and the run it is about (#3785).
 *
 * The rating itself is stored for whoever may use the app. Whether it is also
 * written to the run's ledger as a `human/event` is a question of run access,
 * asked with the intent `feedback`: only the owner of the run writes into it.
 * An admin who reads somebody else's chat, or whoever holds the id of an
 * anonymous visitor's run, gets the same `204` and leaves the run untouched.
 *
 * The real route over the real access check: with `read` in place of
 * `feedback` the admin and the id holder cases fail, and without an intent the
 * owner's rating would never reach the ledger.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startRunAccessHarness, USERS } from './helpers/runAccessHarness.js';

let h;
before(async () => {
  h = await startRunAccessHarness();
  const { default: configCache } = await import('../configCache.js');
  configCache.setCacheEntry('config/platform.json', {
    anonymousAuth: { enabled: true },
    features: { feedback: true }
  });
  const { default: registerFeedbackRoutes } = await import('../routes/chat/feedbackRoutes.js');
  registerFeedbackRoutes(h.extra, { getLocalizedError: async key => key });
});
after(async () => {
  await h.stop();
});

/** The feedback events on a run's ledger. */
async function feedbackEvents(runId) {
  return (await h.runLog.readEvents(runId)).filter(
    event => event.type === 'human/event' && event.data.kind === 'feedback'
  );
}

/** The body the client sends for a rating of the answer a run produced. */
function rating(run, overrides = {}) {
  return {
    messageId: 'msg-1',
    appId: 'chat',
    chatId: run.chatId,
    runId: run.runId,
    rating: 4,
    feedback: 'Good answer',
    ...overrides
  };
}

describe('POST /api/feedback: who writes a rating into the run', () => {
  it('writes the owner’s rating to the run as a human event', async () => {
    const run = await h.seedUserRun();
    const res = await h.send('post', '/api/feedback', { user: USERS.owner }, rating(run));
    assert.equal(res.status, 204, JSON.stringify(res.body));
    const events = await feedbackEvents(run.runId);
    assert.equal(events.length, 1, 'the rating is on the run');
    assert.equal(events[0].data.messageId, 'msg-1');
    assert.equal(events[0].data.rating, 4);
    assert.equal(events[0].data.by, USERS.owner.id);
  });

  it('answers an admin and another user 204 and writes nothing into the run', async () => {
    for (const user of [USERS.admin, USERS.otherUser]) {
      const run = await h.seedUserRun();
      const res = await h.send('post', '/api/feedback', { user }, rating(run));
      assert.equal(res.status, 204, `${user.id}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(await feedbackEvents(run.runId), [], `${user.id} is not the run’s owner`);
    }
  });

  it('writes the rating of an anonymous run only from the browser session that owns its chat', async () => {
    const strangers = [
      {},
      { cookie: `${h.chatOwner.GUEST_COOKIE}=${h.chatOwner.mintGuestId()}` },
      { user: USERS.otherUser },
      { user: USERS.admin }
    ];
    for (const caller of strangers) {
      const run = await h.seedGuestRun();
      const res = await h.send('post', '/api/feedback', caller, rating(run));
      assert.equal(res.status, 204, JSON.stringify(res.body));
      assert.deepEqual(
        await feedbackEvents(run.runId),
        [],
        `the run id alone writes nothing (${JSON.stringify(caller.user?.id ?? caller.cookie ?? 'no cookie')})`
      );
    }
    const run = await h.seedGuestRun();
    const res = await h.send('post', '/api/feedback', { cookie: run.cookie }, rating(run));
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await feedbackEvents(run.runId)).length, 1);
  });

  it('writes nothing when the run belongs to another chat than the one named', async () => {
    const run = await h.seedUserRun();
    const other = await h.seedUserRun();
    const res = await h.send(
      'post',
      '/api/feedback',
      { user: USERS.owner },
      rating(run, { chatId: other.chatId })
    );
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.deepEqual(await feedbackEvents(run.runId), []);
  });
});
