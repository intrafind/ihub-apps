import test from 'node:test';
import assert from 'node:assert/strict';
import runLog from '../../services/loop/RunLog.js';
import { authorizeInteraction } from '../../services/loop/runAccess.js';

const interactionFor = (runId, source = {}) => ({
  id: `int-${runId}`,
  runId,
  kind: 'question',
  status: 'pending',
  source
});

test('authorizeInteraction: owner by recorded principal, admin, anonymous-run id possession; strangers denied', async () => {
  const alice = { id: 'alice', groups: ['users'] };
  const bob = { id: 'bob', groups: ['users'] };
  const admin = { id: 'root', groups: ['admin'] };

  const { runId, principal } = await runLog.startRun({
    runId: 'run-access-owned',
    kind: 'chat',
    user: alice
  });
  const owned = interactionFor(runId, { principalId: principal.id, identityMode: principal.mode });
  assert.equal(await authorizeInteraction(owned, alice), true, 'the recorded principal');
  assert.equal(await authorizeInteraction(owned, admin), true, 'admins');
  assert.equal(await authorizeInteraction(owned, bob), false, 'another user who knows the chat id');
  assert.equal(await authorizeInteraction(owned, null), false, 'anonymous caller on a user run');

  // no principal on the source: the run's ledger record decides
  const fromLedger = interactionFor(runId);
  assert.equal(await authorizeInteraction(fromLedger, alice), true);
  assert.equal(await authorizeInteraction(fromLedger, bob), false);

  // an anonymous run is answerable by whoever presents its id
  const anon = await runLog.startRun({ runId: 'run-access-anon', kind: 'chat', user: null });
  const anonInteraction = interactionFor(anon.runId, { principalId: anon.principal.id });
  assert.equal(await authorizeInteraction(anonInteraction, null), true);
  assert.equal(await authorizeInteraction(anonInteraction, bob), true);

  // unknown run, no principal: denied
  assert.equal(await authorizeInteraction(interactionFor('run-access-unknown'), alice), false);
  assert.equal(await authorizeInteraction(null, admin), false);

  runLog.endRun(runId);
  runLog.endRun(anon.runId);
});
