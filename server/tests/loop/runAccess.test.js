// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `authorizeInteraction` by intent: who reads, answers and cancels an
 * interaction (#3785). The routes are asked in `../steerApproval.test.js`;
 * here the decision itself, also for interactions whose run is gone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import runLog from '../../services/loop/RunLog.js';
import { startTestStorage } from '../helpers/testStorage.js';
import { authorizeInteraction } from '../../services/loop/runAccess.js';
import { getChatRepository } from '../../services/chat/ChatRepository.js';
import { guestOwnerId, mintGuestId, setGuestId } from '../../services/chat/chatOwner.js';

let storage;
before(async () => {
  storage = await startTestStorage();
});
after(async () => {
  await storage.stop();
});

const READ = { intent: 'read' };
const ANSWER = { intent: 'answer' };
const CANCEL = { intent: 'cancel' };

const alice = { id: 'alice', groups: ['users'] };
const bob = { id: 'bob', groups: ['users'] };
const admin = { id: 'root', isAdmin: true, isContentAdmin: true, groups: ['admins'] };

const interactionFor = (runId, source = {}) => ({
  id: `int-${runId}`,
  runId,
  kind: 'question',
  status: 'pending',
  source
});

/** An anonymous principal with the guest identity of one browser session. */
function guestWith(guestId) {
  const user = { id: 'anonymous', groups: ['anonymous'] };
  setGuestId(user, guestId);
  return user;
}

test('a user run: the recorded principal reads, answers and cancels; an admin reads and cancels', async () => {
  const { runId, principal } = await runLog.startRun({
    runId: 'run-access-owned',
    kind: 'chat',
    user: alice
  });
  const owned = interactionFor(runId, { principalId: principal.id, identityMode: principal.mode });

  for (const intent of [READ, ANSWER, CANCEL]) {
    assert.equal(await authorizeInteraction(owned, alice, intent), true, `owner ${intent.intent}`);
    assert.equal(await authorizeInteraction(owned, bob, intent), false, `other ${intent.intent}`);
    assert.equal(await authorizeInteraction(owned, null, intent), false, `anon ${intent.intent}`);
  }
  assert.equal(await authorizeInteraction(owned, admin, READ), true, 'an admin reads');
  assert.equal(await authorizeInteraction(owned, admin, CANCEL), true, 'an admin cancels');
  assert.equal(
    await authorizeInteraction(owned, admin, ANSWER),
    false,
    'an admin does not answer in the owner’s place'
  );

  // No principal on the source: the run's ledger record decides, the same way.
  const fromLedger = interactionFor(runId);
  assert.equal(await authorizeInteraction(fromLedger, alice, ANSWER), true);
  assert.equal(await authorizeInteraction(fromLedger, bob, ANSWER), false);
  assert.equal(await authorizeInteraction(fromLedger, admin, ANSWER), false);
  assert.equal(await authorizeInteraction(fromLedger, admin, READ), true);

  // Unknown run, no principal: denied. Nothing to decide on: denied.
  assert.equal(
    await authorizeInteraction(interactionFor('run-access-unknown'), alice, READ),
    false
  );
  assert.equal(await authorizeInteraction(null, admin, READ), false);

  runLog.endRun(runId);
});

test('an anonymous run: the ids read; only the guest who owns the chat answers', async () => {
  const guestId = mintGuestId();
  const chatId = 'chat-run-access-guest';
  await getChatRepository().ensureChat({
    chatId,
    ownerId: guestOwnerId(guestId),
    identityMode: 'default',
    appId: 'chat',
    title: 'Guest chat',
    origin: { createdVia: 'ui' },
    temporary: true
  });
  const anon = await runLog.startRun({ kind: 'chat', user: null, refs: { chatId } });
  const raised = interactionFor(anon.runId, {
    chatId,
    principalId: anon.principal.id,
    anonymous: true
  });

  // Reading stays with whoever holds the ids, as for the run itself.
  for (const user of [null, bob, guestWith(mintGuestId()), guestWith(guestId), admin]) {
    assert.equal(await authorizeInteraction(raised, user, READ), true);
  }
  // Answering is the owner's: the browser session whose cookie owns the chat.
  for (const intent of [ANSWER, CANCEL]) {
    assert.equal(await authorizeInteraction(raised, guestWith(guestId), intent), true);
    assert.equal(await authorizeInteraction(raised, null, intent), false, 'no cookie');
    assert.equal(
      await authorizeInteraction(raised, guestWith(mintGuestId()), intent),
      false,
      'another browser’s cookie'
    );
    assert.equal(await authorizeInteraction(raised, bob, intent), false, 'a signed-in id holder');
  }
  assert.equal(await authorizeInteraction(raised, admin, ANSWER), false);
  assert.equal(await authorizeInteraction(raised, admin, CANCEL), true);

  // The marker decides without the run too (after a restart), and without a
  // stored chat nobody can prove to be the owner.
  const afterRestart = interactionFor(`anon-${'f'.repeat(32)}`, { chatId, anonymous: true });
  assert.equal(await authorizeInteraction(afterRestart, guestWith(guestId), ANSWER), true);
  assert.equal(await authorizeInteraction(afterRestart, bob, ANSWER), false);
  const noChat = interactionFor(`anon-${'e'.repeat(32)}`, { chatId: 'c-none', anonymous: true });
  assert.equal(await authorizeInteraction(noChat, guestWith(guestId), READ), true);
  assert.equal(await authorizeInteraction(noChat, guestWith(guestId), ANSWER), false);
  const unmarked = interactionFor(`anon-${'d'.repeat(32)}`, { chatId: 'c-none' });
  assert.equal(
    await authorizeInteraction(unmarked, bob, READ),
    false,
    'without the marker an unknown run denies'
  );

  runLog.endRun(anon.runId);
});

test('a run of no person: an admin answers its interactions, and those of no person’s run', async () => {
  const { resolvePrincipal } = await import('../../services/loop/runIdentity.js');
  // The interactions say what their run was; no run is in memory (a restart).
  const ofAgent = interactionFor('exec-agent-gone', {
    principalId: 'agent:researcher',
    identityMode: 'default',
    profileId: 'researcher'
  });
  const ofTrigger = interactionFor('exec-trigger-gone', {
    principalId: 'system',
    identityMode: 'default'
  });
  const hashedAgent = interactionFor('exec-agent-hashed', {
    principalId: (await resolvePrincipal({ id: 'agent:researcher' }, { mode: 'pseudonymized' })).id,
    identityMode: 'pseudonymized',
    profileId: 'researcher'
  });
  for (const interaction of [ofAgent, ofTrigger, hashedAgent]) {
    assert.equal(await authorizeInteraction(interaction, admin, ANSWER), true);
    assert.equal(await authorizeInteraction(interaction, bob, ANSWER), false);
    assert.equal(await authorizeInteraction(interaction, null, ANSWER), false);
  }

  // A person's run stays the person's, whatever else its interaction names.
  const ofAlice = interactionFor('exec-alice-gone', {
    principalId: 'alice',
    identityMode: 'default',
    profileId: 'researcher'
  });
  assert.equal(await authorizeInteraction(ofAlice, admin, ANSWER), false);
  // Another agent's identity is not the identity of this run's agent.
  const otherAgent = interactionFor('exec-other-agent', {
    principalId: 'agent:writer',
    identityMode: 'default',
    profileId: 'researcher'
  });
  assert.equal(await authorizeInteraction(otherAgent, admin, ANSWER), false);

  // The same through the run's own record.
  const agentRun = await runLog.startRun({
    kind: 'agent',
    user: { id: 'agent:researcher', isAgent: true, groups: ['agents'] },
    refs: { profileId: 'researcher' }
  });
  assert.equal(await authorizeInteraction(interactionFor(agentRun.runId), admin, ANSWER), true);
  assert.equal(await authorizeInteraction(interactionFor(agentRun.runId), bob, ANSWER), false);
  // An agent run that runs as a person is that person's.
  const asAlice = await runLog.startRun({
    kind: 'agent',
    user: alice,
    refs: { profileId: 'researcher' }
  });
  assert.equal(await authorizeInteraction(interactionFor(asAlice.runId), admin, ANSWER), false);
  assert.equal(await authorizeInteraction(interactionFor(asAlice.runId), alice, ANSWER), true);

  runLog.endRun(agentRun.runId);
  runLog.endRun(asAlice.runId);
});
