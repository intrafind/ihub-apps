// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A message is never the answer to an approval, and an approval is answered
 * by the owner of its run (#3785, #3191).
 *
 * Asked of the real routes: `POST /api/runs/{runId}/human-events` and
 * `POST /api/runs/{runId}/interactions/{id}/answer`, with interactions raised
 * through the interaction service the way a run raises them.
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

/**
 * Raise an approval the generic answer endpoint settles (a scheduled run's,
 * a policy's: not a chat tool approval, which the next chat message answers).
 */
function raiseApproval(run, source = {}, policy = {}) {
  return h.interactionService.raise({
    runId: run.runId,
    kind: 'approval',
    origin: 'policy',
    prompt: {
      title: 'Send the mail?',
      message: 'Send the mail to the customer?',
      inputType: 'confirm'
    },
    policy,
    source: {
      ...(run.chatId ? { chatId: run.chatId } : {}),
      ...(run.principalId ? { principalId: run.principalId, identityMode: 'default' } : {}),
      ...source
    }
  });
}

const answerUrl = interaction =>
  `/api/runs/${interaction.runId}/interactions/${interaction.id}/answer`;
const statusOf = async interaction => (await h.interactionService.get(interaction.id))?.status;
const humanEvents = async runId =>
  (await h.runLog.readEvents(runId)).filter(event => event.type === 'human/event');

describe('a message while the run waits for an approval', () => {
  it('leaves the approval pending: "I approve" is refused with RUN_NOT_ACTIVE', async () => {
    const run = await h.seedUserRun();
    const approval = await raiseApproval(run);

    const res = await h.send(
      'post',
      `/api/runs/${run.runId}/human-events`,
      { user: USERS.owner },
      { kind: 'steer', message: 'I approve' }
    );
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.headers['content-type'], /^application\/problem\+json/);
    assert.equal(res.body.code, 'RUN_NOT_ACTIVE');

    assert.equal(await statusOf(approval), 'pending', 'the approval is still pending');
    assert.deepEqual(await humanEvents(run.runId), [], 'nothing was written to the ledger');
    assert.deepEqual(h.steering.takeSteers(run.runId), [], 'nothing waits for the loop');
  });

  it('accepts the message once the approval was answered where it is shown', async () => {
    const run = await h.seedUserRun();
    const approval = await raiseApproval(run);
    const answered = await h.send(
      'post',
      answerUrl(approval),
      { user: USERS.owner },
      { decision: 'approve' }
    );
    assert.equal(answered.status, 200, JSON.stringify(answered.body));

    const res = await h.send(
      'post',
      `/api/runs/${run.runId}/human-events`,
      { user: USERS.owner },
      { kind: 'steer', message: 'And add the invoice number' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.effect, 'steer_queued');
  });

  it('still stops the run: a stop is never held back by a pending approval', async () => {
    const run = await h.seedUserRun();
    await raiseApproval(run);
    const res = await h.send(
      'post',
      `/api/runs/${run.runId}/human-events`,
      { user: USERS.owner },
      { kind: 'stop' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});

describe('who answers an approval', () => {
  it('refuses an admin and another user, and lets the owner answer', async () => {
    const run = await h.seedUserRun();
    const approval = await raiseApproval(run);

    for (const user of [USERS.admin, USERS.otherUser]) {
      const res = await h.send('post', answerUrl(approval), { user }, { decision: 'approve' });
      assert.equal(res.status, 403, `${user.id}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'FORBIDDEN');
      assert.equal(await statusOf(approval), 'pending');
    }

    const res = await h.send(
      'post',
      answerUrl(approval),
      { user: USERS.owner },
      { decision: 'approve' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.answer.decision, 'approve');
  });

  it('lets an admin cancel what they may not answer, and stop its run', async () => {
    const run = await h.seedUserRun();
    const approval = await raiseApproval(run);
    const { authorizeInteraction } = h.runAccess;
    const stored = await h.interactionService.get(approval.id);

    assert.equal(await authorizeInteraction(stored, USERS.admin, { intent: 'answer' }), false);
    assert.equal(await authorizeInteraction(stored, USERS.admin, { intent: 'cancel' }), true);
    assert.equal(await authorizeInteraction(stored, USERS.otherUser, { intent: 'cancel' }), false);

    const stop = await h.send(
      'post',
      `/api/runs/${run.runId}/human-events`,
      { user: USERS.admin },
      { kind: 'stop' }
    );
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    const entries = await h.auditEntriesFor(run.runId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor.id, USERS.admin.id);

    await h.interactionService.cancel(approval.id, 'cancelled');
    assert.equal(await statusOf(approval), 'cancelled');
  });

  it('keeps approver groups as they were: their members and an admin answer', async () => {
    const run = await h.seedUserRun();
    const approval = await raiseApproval(run, {}, { approverGroups: ['reviewers'] });

    const stranger = await h.send(
      'post',
      answerUrl(approval),
      { user: USERS.otherUser },
      { decision: 'approve' }
    );
    assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
    assert.equal(await statusOf(approval), 'pending');

    const admin = await h.send(
      'post',
      answerUrl(approval),
      { user: USERS.admin },
      { decision: 'approve' }
    );
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
  });
});

describe('an interaction of a run that belongs to no person', () => {
  it('is answered by an admin: nobody else could, and no user’s rights are used', async () => {
    // An agent run under the agent's own identity, as the agent runtime starts it.
    const { runId, principal } = await h.runLog.startRun({
      kind: 'agent',
      user: { id: 'agent:researcher', isAgent: true, groups: ['agents'] },
      refs: { profileId: 'researcher' }
    });
    const question = await h.interactionService.raise({
      runId,
      kind: 'question',
      origin: 'tool',
      prompt: { message: 'Which year?', inputType: 'text' },
      source: { principalId: principal.id, identityMode: 'default', profileId: 'researcher' }
    });

    const stranger = await h.send(
      'post',
      answerUrl(question),
      { user: USERS.otherUser },
      { value: '2024' }
    );
    assert.equal(stranger.status, 403, JSON.stringify(stranger.body));

    const admin = await h.send(
      'post',
      answerUrl(question),
      { user: USERS.admin },
      { value: '2024' }
    );
    assert.equal(admin.status, 200, JSON.stringify(admin.body));

    // Answering is all an admin does there: no message into the run.
    const steer = await h.send(
      'post',
      `/api/runs/${runId}/human-events`,
      { user: USERS.admin },
      { kind: 'steer', message: 'Hurry up' }
    );
    assert.equal(steer.status, 403);
    assert.equal(steer.body.code, 'RUN_STEER_FORBIDDEN');
  });
});

describe('an interaction of an anonymous run', () => {
  it('is answered only from the browser session that owns its chat', async () => {
    const run = await h.seedGuestRun();
    const question = await h.interactionService.raise({
      runId: run.runId,
      kind: 'question',
      origin: 'tool',
      prompt: { message: 'Which year?', inputType: 'text' },
      source: { chatId: run.chatId, principalId: run.runId, anonymous: true }
    });
    const strangers = [
      {},
      { cookie: `${h.chatOwner.GUEST_COOKIE}=${h.chatOwner.mintGuestId()}` },
      { user: USERS.otherUser },
      { user: USERS.admin }
    ];
    for (const caller of strangers) {
      const res = await h.send('post', answerUrl(question), caller, { value: '2024' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(await statusOf(question), 'pending');
    }

    // Whoever holds the ids still sees that the run waits.
    const listed = await h.send('get', `/api/runs/${run.runId}/interactions`, {});
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);

    const res = await h.send(
      'post',
      answerUrl(question),
      { cookie: run.cookie },
      { value: '2024' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.answer.value, '2024');
  });
});
