// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Why a chat turn was aborted.
 *
 * Every way a turn can be stopped ends in `controller.abort()` on the
 * controller `ChatService.runTurn` registered in `activeRequests`. Without a
 * reason the turn ends `aborted` and nothing says by whom or from where. The
 * place that decides to stop builds a cause here and passes it as the abort
 * reason; `runTurn` reads it back and records it on the ledger, the stored
 * message and the scheduled run.
 *
 * The reason is an `AbortError` that carries the cause. A bare object would
 * not do: `fetch` rejects with whatever the signal was aborted with, and the
 * loop recognises an abort by the error's name (`isAbortError`).
 *
 * @module services/chat/abortCause
 */
import os from 'node:os';
import { resolveActorId } from '../loop/runIdentity.js';

/**
 * Cause kinds and the sentence stored for each. Keep in step with the client's
 * `abortCauses.*` strings.
 */
export const ABORT_KINDS = Object.freeze({
  user_stop: 'Stopped from the chat',
  run_stop: 'Stopped through the run API',
  task_run_cancelled: 'Cancelled by the owner',
  task_deleted: 'The task was deleted',
  task_disabled: 'Disabled by an administrator',
  chat_deleted: 'The chat was deleted',
  user_deleted: 'The user was deleted',
  superseded: 'Replaced by a newer message in the same chat',
  client_disconnected: 'The browser disconnected',
  client_evicted: 'The browser connection timed out',
  api_client_closed: 'The API client closed the connection',
  lease_lost: 'The run lost its execution lease to another worker',
  unknown: 'Stopped (the cause was not recorded)'
});

/** Who decided: a person, an administrator acting on someone else's work, or the server itself. */
const ACTOR_TYPES = new Set(['user', 'admin', 'system']);

const MAX_FIELD = 200;

function clip(value) {
  return String(value).slice(0, MAX_FIELD);
}

/** `host:pid` — which process decided, since the turn often runs in another one. */
export function workerId() {
  return `${os.hostname()}:${process.pid}`;
}

// The pieces of a cause. The builder and the normalizer share them, so the
// two cannot drift apart on what a well-formed cause looks like.

function messageOf(message, kind) {
  return clip(typeof message === 'string' && message ? message : ABORT_KINDS[kind]);
}

function timeOf(at) {
  const parsed = Date.parse(at);
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function actorOf(actor) {
  const hasId = typeof actor?.id === 'string' && actor.id;
  return {
    type: ACTOR_TYPES.has(actor?.type) ? actor.type : 'system',
    ...(hasId ? { id: clip(actor.id) } : {}),
    ...(actor?.owner === true ? { owner: true } : {})
  };
}

function originOf({ via, source, worker } = {}) {
  return {
    via: clip(via || 'unspecified'),
    ...(source ? { source: clip(source) } : {}),
    ...(worker ? { worker: clip(worker) } : {})
  };
}

/** Ids that are absent (a run that was never started) or empty are left out. */
function relatedOf(related) {
  if (!related || typeof related !== 'object') return {};
  const entries = Object.entries(related)
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([key, value]) => [clip(key), clip(value)]);
  return entries.length > 0 ? { related: Object.fromEntries(entries) } : {};
}

/** The one place a cause is put together, so the builder and the normalizer cannot drift apart. */
function assemble({ kind, message, at, actor, origin, related }) {
  return {
    kind,
    message: messageOf(message, kind),
    at: timeOf(at),
    actor: actorOf(actor),
    origin: originOf(origin),
    ...relatedOf(related)
  };
}

function knownKind(kind) {
  return Object.hasOwn(ABORT_KINDS, kind) ? kind : 'unknown';
}

/**
 * Build a cause.
 *
 * @param {keyof typeof ABORT_KINDS} kind
 * @param {Object} [options]
 * @param {{type?: string, id?: string}} [options.actor] - Defaults to the system.
 * @param {string} [options.via] - The code path that decided, e.g. `POST /api/apps/:appId/chat/:chatId/stop`.
 * @param {string} [options.source] - The client surface that asked (`stop-button`, `compare`, …).
 * @param {Object<string, string>} [options.related] - Ids of related things (the superseding run, the task).
 * @param {string} [options.message] - Overrides the sentence of the kind.
 * @returns {{kind: string, message: string, at: string, actor: Object, origin: Object, related?: Object}}
 */
export function abortCause(kind, options = {}) {
  const { actor, via, source, related, message } = options;
  return assemble({
    kind: knownKind(kind),
    message,
    at: new Date().toISOString(),
    actor,
    origin: { via, source, worker: workerId() },
    related
  });
}

/**
 * A cause for a stop a person asked for. The actor id goes through
 * `resolveActorId`, so a pseudonymized ledger never carries a raw user id.
 *
 * @param {keyof typeof ABORT_KINDS} kind
 * @param {Object|null} user
 * @param {Object} [options] - As {@link abortCause}, plus:
 * @param {string} [options.mode] - The identity mode of what is stopped (its chat, task or run)
 * @param {boolean} [options.admin] - An administrator acting on someone else's work
 * @param {string} [options.ownerId] - The owner's id in that same mode. When the stopper is the
 *   owner the cause says so (`actor.owner`), which lets the owner read "you" even where the
 *   id is a pseudonym the browser cannot match.
 * @returns {Promise<Object>}
 */
export async function userAbortCause(
  kind,
  user,
  { mode = 'default', admin = false, ownerId, ...rest } = {}
) {
  const id = await resolveActorId(user, { mode }).catch(() => undefined);
  const owner = Boolean(ownerId) && id === ownerId;
  return abortCause(kind, { ...rest, actor: { type: admin ? 'admin' : 'user', id, owner } });
}

/**
 * The part of a cause that is safe to show anyone who can read the message:
 * what happened, not who did it, from where or on which worker. Used for
 * messages that leave the owner's reach (a shared chat's snapshot).
 *
 * @param {*} cause
 * @returns {{kind: string, message: string}|null}
 */
export function publicAbortCause(cause) {
  if (!cause || typeof cause !== 'object') return null;
  const { kind, message } = normalizeAbortCause(cause);
  return { kind, message };
}

/** An `AbortError` carrying a cause: the value to pass to `controller.abort()`. */
export function abortReason(cause) {
  const normalized = normalizeAbortCause(cause);
  const error = new Error(normalized.message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  error.abortCause = normalized;
  return error;
}

/**
 * Whatever came over the wire or out of `signal.reason`, as a well-formed
 * cause. Unknown input becomes the `unknown` cause, so a caller that aborts
 * without one is still recorded.
 *
 * @param {*} value - A cause, an error carrying one, or anything else.
 * @returns {Object}
 */
export function normalizeAbortCause(value) {
  const candidate = value?.abortCause || value;
  return isKnownCause(candidate) ? assemble(candidate) : abortCause('unknown');
}

function isKnownCause(candidate) {
  return (
    Boolean(candidate) &&
    typeof candidate === 'object' &&
    Object.hasOwn(ABORT_KINDS, candidate.kind)
  );
}

/** The cause a signal was aborted with, or the `unknown` cause. */
export function causeOfSignal(signal) {
  return normalizeAbortCause(signal?.reason);
}

/** One structured log line for a decision to abort. */
export function describeCause(cause) {
  return {
    kind: cause.kind,
    actorType: cause.actor?.type,
    actorId: cause.actor?.id,
    via: cause.origin?.via,
    source: cause.origin?.source,
    worker: cause.origin?.worker,
    ...(cause.related ? { related: cause.related } : {})
  };
}
