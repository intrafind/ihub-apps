import crypto from 'node:crypto';
import logger from '../../utils/logger.js';
import { createPresenceMap, hasRemote, request, respond } from '../../clusterBus.js';

/**
 * One-time hand-offs of a chat that is not stored server-side, from the
 * Outlook task pane to the web app ("Open in web app").
 *
 * A stored chat needs no hand-off — the browser opens it by id from the chat
 * store. A chat that is not stored (durable chats off, or an `ephemeral` app)
 * exists only in the pane's session storage, which the user's browser cannot
 * read: the pane runs in Outlook's web view, the browser in its own process.
 * So the pane parks the transcript here, gets a token back, and opens the web
 * app with it; the web app claims the transcript with the same user's session
 * and continues the chat in a new chat of its own.
 *
 * The record is deliberately not a stored chat:
 *
 *  - **single-use** — claiming it removes it, so a link in the browser history
 *    leads nowhere afterwards;
 *  - **short-lived** — ten minutes, enough to get through a sign-in in the
 *    browser first;
 *  - **owner-bound** — only the user who parked it can claim it. A claim by
 *    anyone else is refused and leaves the record for its owner;
 *  - **in memory** — nothing reaches disk, and a restart forgets everything.
 *
 * Cluster mode works like `utils/authorizationCodeStore.js`, and for the same
 * reason: the pane's POST and the browser's claim are separate requests that
 * land on different workers. The record stays on the worker that took it, its
 * ownership is announced over the cluster bus by a random handle, and a
 * worker that receives the claim asks the owner to consume it — so exactly
 * one process ever holds a record, and single use stays atomic. Tokens are
 * `<handle>.<secret>`; only the handle is broadcast.
 *
 * @module services/chat/chatHandoffStore
 */

/** Presence namespace for hand-off ownership announcements. */
const PRESENCE_KIND = 'chathandoff';

/** Bus channel on which a non-owning worker asks the owner to consume one. */
const CLAIM_CHANNEL = 'chathandoff:claim';

/** How long to wait for the owning worker. */
const CLAIM_TIMEOUT_MS = 3000;

/** How long a parked chat waits to be claimed. */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

/** Records one worker holds at most. */
export const MAX_HANDOFFS_PER_WORKER = 500;

/**
 * Serialized bytes one worker holds at most, across all records. A record
 * may be megabytes (the email rides along), so the count alone would let a
 * few hundred users park gigabytes; past the budget the oldest records go.
 */
export const MAX_HANDOFF_BYTES_PER_WORKER = 128 * 1024 * 1024;

/** Records one user holds at most; older ones make room for newer. */
export const MAX_HANDOFFS_PER_USER = 5;

const CLEANUP_INTERVAL_MS = 60 * 1000;
const HANDLE_BYTES = 16;
const SECRET_BYTES = 32;

/**
 * Records parked on this worker, keyed by handle.
 *
 * @type {Map<string, { secret: string, ownerId: string, data: Object, bytes: number, expiresAt: number, createdAt: number }>}
 */
const handoffs = createPresenceMap(PRESENCE_KIND);

function splitToken(token) {
  if (typeof token !== 'string') return null;
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;
  return { handle: token.slice(0, separator), secret: token.slice(separator + 1) };
}

function secretsMatch(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** Drop expired records and, when the worker is full, the oldest. */
export function cleanup(now = Date.now()) {
  for (const [handle, entry] of handoffs.entries()) {
    if (now > entry.expiresAt) handoffs.delete(handle);
  }
}

function heldBytes() {
  let total = 0;
  for (const entry of handoffs.values()) total += entry.bytes || 0;
  return total;
}

function makeRoom(ownerId, bytes) {
  cleanup();
  const own = [...handoffs.entries()]
    .filter(([, entry]) => entry.ownerId === ownerId)
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (own.length >= MAX_HANDOFFS_PER_USER) handoffs.delete(own.shift()[0]);
  const oldest = [...handoffs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  let total = heldBytes();
  while (
    oldest.length > 0 &&
    (handoffs.size >= MAX_HANDOFFS_PER_WORKER || total + bytes > MAX_HANDOFF_BYTES_PER_WORKER)
  ) {
    const [handle, entry] = oldest.shift();
    handoffs.delete(handle);
    total -= entry.bytes || 0;
  }
}

/**
 * Park a chat for its owner.
 *
 * @param {string} ownerId - `req.user.id` of the user handing the chat off.
 * @param {Object} data - What the web app continues with (already validated).
 * @param {number} [bytes] - Its serialized size, for the worker's byte budget.
 * @returns {{ token: string, expiresAt: number }}
 */
export function parkHandoff(
  ownerId,
  data,
  bytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
) {
  makeRoom(ownerId, bytes);
  const handle = crypto.randomBytes(HANDLE_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const now = Date.now();
  const expiresAt = now + HANDOFF_TTL_MS;
  handoffs.set(handle, { secret, ownerId, data, bytes, expiresAt, createdAt: now });
  return { token: `${handle}.${secret}`, expiresAt };
}

/**
 * Consume a record this worker holds.
 *
 * @returns {{ data: Object }|{ error: 'notFound'|'notOwner' }}
 */
function claimLocal(handle, secret, claimantId) {
  const entry = handoffs.get(handle);
  if (!entry) return { error: 'notFound' };
  if (Date.now() > entry.expiresAt) {
    handoffs.delete(handle);
    return { error: 'notFound' };
  }
  if (entry.ownerId !== claimantId) {
    // Someone else's browser opened the link (a shared machine, a forwarded
    // URL, an edited one). Not theirs to read — and, whatever secret they
    // send, not theirs to destroy either. Checked before the secret for that
    // reason: the handle alone is in the link they have.
    return { error: 'notOwner' };
  }
  if (!secretsMatch(secret, entry.secret)) {
    // The owner, with a valid handle and the wrong secret: not an honest
    // mistake, so the record goes.
    handoffs.delete(handle);
    logger.warn('Chat hand-off secret mismatch - discarding it', { component: 'ChatHandoff' });
    return { error: 'notFound' };
  }
  handoffs.delete(handle);
  return { data: entry.data };
}

/**
 * Claim a parked chat (single-use, cluster-wide).
 *
 * @param {string} token - From {@link parkHandoff}.
 * @param {string} claimantId - `req.user.id` of the user claiming it.
 * @returns {Promise<{ data: Object }|{ error: 'notFound'|'notOwner' }>}
 */
export async function claimHandoff(token, claimantId) {
  const parts = splitToken(token);
  if (!parts) return { error: 'notFound' };
  const { handle, secret } = parts;

  if (handoffs.has(handle)) return claimLocal(handle, secret, claimantId);

  if (hasRemote(PRESENCE_KIND, handle)) {
    const reply = await request(
      CLAIM_CHANNEL,
      { handle, secret, claimantId },
      { route: { kind: PRESENCE_KIND, key: handle }, timeoutMs: CLAIM_TIMEOUT_MS }
    );
    if (reply && (reply.data || reply.error)) return reply;
    logger.warn('Chat hand-off owner did not respond', { component: 'ChatHandoff' });
  }
  return { error: 'notFound' };
}

// Serve claims for records parked on this worker. `undefined` when the handle
// is not here, so a broadcast question is answered by the real owner only.
respond(CLAIM_CHANNEL, ({ handle, secret, claimantId } = {}) => {
  if (!handle || !handoffs.has(handle)) return undefined;
  return claimLocal(handle, secret, claimantId);
});

const cleanupInterval = setInterval(cleanup, CLEANUP_INTERVAL_MS);
if (cleanupInterval.unref) cleanupInterval.unref();
