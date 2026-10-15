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
export function abortCause(kind, { actor, via, source, related, message } = {}) {
  const known = Object.hasOwn(ABORT_KINDS, kind) ? kind : 'unknown';
  const actorType = ACTOR_TYPES.has(actor?.type) ? actor.type : 'system';
  // Ids that are absent (a run that was never started) or empty are left out.
  const relatedEntries = Object.entries(related || {}).filter(([, value]) => Boolean(value));
  return {
    kind: known,
    message: clip(message || ABORT_KINDS[known]),
    at: new Date().toISOString(),
    actor: {
      type: actorType,
      ...(actor?.id ? { id: clip(actor.id) } : {})
    },
    origin: {
      via: clip(via || 'unspecified'),
      ...(source ? { source: clip(source) } : {}),
      worker: workerId()
    },
    ...(relatedEntries.length > 0
      ? { related: Object.fromEntries(relatedEntries.map(([key, value]) => [key, clip(value)])) }
      : {})
  };
}

/**
 * A cause for a stop a person asked for. The actor id goes through
 * `resolveActorId`, so a pseudonymized ledger never carries a raw user id.
 *
 * @param {keyof typeof ABORT_KINDS} kind
 * @param {Object|null} user
 * @param {Object} [options] - As {@link abortCause}, plus `mode` (the run's identity mode) and `admin`.
 * @returns {Promise<Object>}
 */
export async function userAbortCause(
  kind,
  user,
  { mode = 'default', admin = false, ...rest } = {}
) {
  const id = await resolveActorId(user, { mode }).catch(() => undefined);
  return abortCause(kind, { ...rest, actor: { type: admin ? 'admin' : 'user', id } });
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
  if (candidate && typeof candidate === 'object' && Object.hasOwn(ABORT_KINDS, candidate.kind)) {
    const at = Date.parse(candidate.at);
    return {
      kind: candidate.kind,
      message: clip(
        typeof candidate.message === 'string' && candidate.message
          ? candidate.message
          : ABORT_KINDS[candidate.kind]
      ),
      at: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString(),
      actor: {
        type: ACTOR_TYPES.has(candidate.actor?.type) ? candidate.actor.type : 'system',
        ...(typeof candidate.actor?.id === 'string' ? { id: clip(candidate.actor.id) } : {})
      },
      origin: {
        via: clip(candidate.origin?.via || 'unspecified'),
        ...(candidate.origin?.source ? { source: clip(candidate.origin.source) } : {}),
        ...(candidate.origin?.worker ? { worker: clip(candidate.origin.worker) } : {})
      },
      ...(candidate.related && typeof candidate.related === 'object'
        ? {
            related: Object.fromEntries(
              Object.entries(candidate.related)
                .filter(([, v]) => typeof v === 'string' && v)
                .map(([k, v]) => [clip(k), clip(v)])
            )
          }
        : {})
    };
  }
  return abortCause('unknown');
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
