import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABORT_KINDS,
  abortCause,
  abortReason,
  causeOfSignal,
  normalizeAbortCause,
  publicAbortCause,
  userAbortCause
} from '../../services/chat/abortCause.js';
import { resolveActorId } from '../../services/loop/runIdentity.js';
import { isAbortError } from '../../services/loop/contracts/errors.js';
import { activeRequests, abortChatRequest, applyRelayedAbort } from '../../sse.js';
import { snapshotMessage, withPublicCause } from '../../services/chat/ChatShareRepository.js';

test('a cause says what, who, from where and when', () => {
  const cause = abortCause('user_stop', {
    actor: { type: 'user', id: 'user-1' },
    via: 'POST /stop',
    source: 'stop-button',
    related: { runId: 'chat-1', empty: '' }
  });
  assert.equal(cause.kind, 'user_stop');
  assert.equal(cause.message, ABORT_KINDS.user_stop);
  assert.deepEqual(cause.actor, { type: 'user', id: 'user-1' });
  assert.equal(cause.origin.via, 'POST /stop');
  assert.equal(cause.origin.source, 'stop-button');
  assert.match(cause.origin.worker, /:\d+$/);
  assert.deepEqual(cause.related, { runId: 'chat-1' }, 'empty related values are dropped');
  assert.ok(Number.isFinite(Date.parse(cause.at)));
});

test('an unknown kind or actor type falls back instead of being stored as given', () => {
  const cause = abortCause('made_up', { actor: { type: 'root', id: 'x' } });
  assert.equal(cause.kind, 'unknown');
  assert.equal(cause.actor.type, 'system');
});

test('the actor id of a person goes through the run identity mode', async () => {
  const plain = await userAbortCause('user_stop', { id: 'user-7' }, { via: 'v' });
  assert.deepEqual(plain.actor, { type: 'user', id: 'user-7' });
  const hashed = await userAbortCause('user_stop', { id: 'user-7' }, { mode: 'pseudonymized' });
  assert.notEqual(hashed.actor.id, 'user-7', 'a pseudonymized ledger never gets the raw id');
  const anonymous = await userAbortCause('user_stop', { id: 'anonymous' });
  assert.equal(anonymous.actor.id, 'anonymous');
  const admin = await userAbortCause('task_disabled', { id: 'root' }, { admin: true });
  assert.equal(admin.actor.type, 'admin');
});

test('the abort reason still counts as an abort, and carries the cause', () => {
  const cause = abortCause('superseded');
  const reason = abortReason(cause);
  assert.equal(isAbortError(reason), true);
  const controller = new AbortController();
  controller.abort(reason);
  assert.deepEqual(causeOfSignal(controller.signal), normalizeAbortCause(cause));
});

test('a signal aborted without a cause reads as unknown', () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(causeOfSignal(controller.signal).kind, 'unknown');
  assert.equal(causeOfSignal(undefined).kind, 'unknown');
});

test('normalizing keeps only known fields and bounds their length', () => {
  const cause = normalizeAbortCause({
    kind: 'user_stop',
    message: 'x'.repeat(1000),
    at: 'not a date',
    actor: { type: 'user', id: 'u', password: 'secret' },
    origin: { via: 'v', extra: 'dropped' },
    extra: 'dropped'
  });
  assert.equal(cause.message.length, 200);
  assert.ok(Number.isFinite(Date.parse(cause.at)));
  assert.deepEqual(Object.keys(cause).sort(), ['actor', 'at', 'kind', 'message', 'origin']);
  assert.deepEqual(cause.actor, { type: 'user', id: 'u' });
  assert.deepEqual(cause.origin, { via: 'v' });
});

test('abortChatRequest aborts the registered turn with the cause it was given', () => {
  const controller = new AbortController();
  activeRequests.set('chat-abort-cause', controller);
  const applied = abortChatRequest('chat-abort-cause', abortCause('user_stop', { via: 'test' }));
  assert.equal(applied, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(causeOfSignal(controller.signal).kind, 'user_stop');
  assert.equal(activeRequests.has('chat-abort-cause'), false);
});

test('the owner is marked in the cause without exposing their raw id', async () => {
  const ownerId = await resolveActorId({ id: 'user-7' }, { mode: 'pseudonymized' });
  const own = await userAbortCause(
    'user_stop',
    { id: 'user-7' },
    { mode: 'pseudonymized', ownerId }
  );
  assert.equal(own.actor.owner, true);
  assert.notEqual(own.actor.id, 'user-7');
  const other = await userAbortCause(
    'user_stop',
    { id: 'user-8' },
    { mode: 'pseudonymized', ownerId }
  );
  assert.equal(other.actor.owner, undefined, 'someone else is not marked as the owner');
  assert.deepEqual(normalizeAbortCause(own).actor, own.actor, 'the mark survives a round trip');
});

test('a share keeps the explanation of a stop and nothing about who or where', async () => {
  const cause = await userAbortCause(
    'user_stop',
    { id: 'user-7' },
    { via: 'POST /stop', source: 'stop-button', related: { runId: 'chat-1' } }
  );
  assert.deepEqual(publicAbortCause(cause), { kind: 'user_stop', message: cause.message });
  assert.equal(publicAbortCause('nonsense'), null);

  const message = {
    id: 'm',
    role: 'assistant',
    content: 'half an answer',
    error: { code: 'ABORTED', message: cause.message, cause }
  };
  const snapshot = snapshotMessage(message);
  assert.deepEqual(snapshot.error, {
    code: 'ABORTED',
    message: cause.message,
    cause: { kind: 'user_stop', message: cause.message }
  });
  assert.ok(!JSON.stringify(snapshot).includes('user-7'));
  assert.ok(!JSON.stringify(snapshot).includes('runId'));
  // The owner's stored message is untouched.
  assert.equal(message.error.cause.actor.id, 'user-7');
  // A snapshot written before this existed is cut down when a viewer gets it.
  assert.deepEqual(withPublicCause(message.error).cause, {
    kind: 'user_stop',
    message: cause.message
  });
});

test('an abort relayed from another worker applies to the turn that was running, not a newer one', () => {
  const old = new AbortController();
  old.startedAt = 1000;
  activeRequests.set('chat-relayed', old);
  const superseding = abortCause('superseded', { via: 'test' });
  assert.equal(
    applyRelayedAbort({ chatId: 'chat-relayed', cause: superseding, before: 1500 }),
    true
  );
  assert.equal(causeOfSignal(old.signal).kind, 'superseded');

  // The same message arriving after a newer turn took the chat over is stale.
  const newer = new AbortController();
  newer.startedAt = 2000;
  activeRequests.set('chat-relayed', newer);
  assert.equal(
    applyRelayedAbort({ chatId: 'chat-relayed', cause: superseding, before: 1500 }),
    false
  );
  assert.equal(newer.signal.aborted, false);
  // A Stop names no moment: it ends whatever runs.
  assert.equal(applyRelayedAbort({ chatId: 'chat-relayed', cause: abortCause('user_stop') }), true);
  assert.equal(newer.signal.aborted, true);
});
