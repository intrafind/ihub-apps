import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABORT_KINDS,
  abortCause,
  abortReason,
  causeOfSignal,
  normalizeAbortCause,
  userAbortCause
} from '../../services/chat/abortCause.js';
import { isAbortError } from '../../services/loop/contracts/errors.js';
import { activeRequests, abortChatRequest } from '../../sse.js';

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
