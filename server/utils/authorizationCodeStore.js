import crypto from 'crypto';
import logger from './logger.js';
import { createPresenceMap, hasRemote, request, respond } from '../clusterBus.js';

/**
 * Store for OAuth authorization codes.
 *
 * Authorization codes are short-lived (10 minutes) and single-use by
 * design (RFC 6749 section 4.1.2). Consuming a code removes it immediately,
 * so a second use attempt always returns null.
 *
 * ## Why this is not just a Map
 *
 * The two halves of the authorization code flow are two separate HTTP
 * requests, and in cluster mode they land on different workers: the browser's
 * `POST /api/oauth/authorize/decision` mints the code on worker A, then the
 * client's `POST /api/oauth/token` is round-robined to whichever worker is
 * next. A plain per-process Map therefore answers "code not found" on nearly
 * every token exchange, which surfaces to the client as
 * `invalid_grant: Authorization code is invalid or expired` with no bad input
 * anywhere.
 *
 * Replicating the code to every worker would fix the lookup and break the
 * security property: reading a code *consumes* it, and N copies means N
 * consumptions, i.e. no replay protection. So the code stays on the worker
 * that minted it, ownership is announced over the cluster bus
 * (`server/clusterBus.js`), and a worker that receives the token request asks
 * the owner to consume it. Exactly one process ever holds a given code, so
 * single-use remains atomic without any distributed agreement.
 *
 * ## Code shape: a public handle plus a secret
 *
 * A code is `<handle>.<secret>` — 128 bits of routing handle and 256 bits of
 * secret, both from `crypto.randomBytes`.
 *
 * The split exists because ownership announcements are *broadcast to every
 * worker and retained* for the life of the code. Keying them by the code
 * itself would put a live credential in every process's memory for ten
 * minutes. Keying them by the handle puts nothing there: the handle is a
 * random label that grants nothing on its own, and the secret half never
 * appears in an announcement.
 *
 * The secret does cross the IPC boundary once, in the single directed consume
 * message to the owning worker, which verifies and destroys it. That is
 * unavoidable — only the owner can verify — and is a different exposure from a
 * retained broadcast. Comparison is constant-time.
 *
 * Nothing is persisted across restarts. That is intentional: a restarted
 * server is a clean slate, and codes issued before the restart simply expire
 * as if they were never issued.
 *
 * @module authorizationCodeStore
 */

/** Presence namespace for code ownership announcements. */
const PRESENCE_KIND = 'authcode';

/** Bus channel on which a non-owning worker asks the owner to consume a code. */
const CONSUME_CHANNEL = 'authcode:consume';

/**
 * How long to wait for the owning worker to answer. Generous relative to two
 * IPC hops, but well inside any OAuth client's token-request timeout, so a
 * wedged worker degrades to `invalid_grant` rather than a hung request.
 */
const CONSUME_TIMEOUT_MS = 2000;

/**
 * Codes minted by *this* worker, keyed by handle. Membership is announced to
 * the cluster so other workers can route a consume request here.
 *
 * @type {Map<string, { secret: string, data: Object, expiresAt: number }>}
 */
const codeStore = createPresenceMap(PRESENCE_KIND);

/** Authorization codes expire after 10 minutes (RFC 6749 recommendation). */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Periodic cleanup runs every 5 minutes to remove stale entries. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Bytes of entropy in each half of a code. */
const HANDLE_BYTES = 16;
const SECRET_BYTES = 32;

/**
 * Split a code into its routing handle and secret halves.
 *
 * @param {string} code - The authorization code as issued.
 * @returns {{handle: string, secret: string}|null} Parts, or null if the value
 *   is not shaped like a code this store issued.
 */
function splitCode(code) {
  if (typeof code !== 'string') return null;
  const separator = code.indexOf('.');
  if (separator <= 0 || separator === code.length - 1) return null;
  return { handle: code.slice(0, separator), secret: code.slice(separator + 1) };
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secretsMatch(a, b) {
  // timingSafeEqual throws on a length mismatch, which is itself a rejection.
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Store an authorization code with its associated request data.
 *
 * The data object should contain everything needed to validate a subsequent
 * token request: clientId, redirectUri, userId, scopes, codeChallenge,
 * codeChallengeMethod, and nonce.
 *
 * @param {string} code - The authorization code from `generateCode()`.
 * @param {Object} data - Payload bound to this code.
 * @param {string} data.clientId - OAuth client that requested the code.
 * @param {string} data.redirectUri - Redirect URI from the authorization request.
 * @param {string} data.userId - Authenticated user identifier.
 * @param {string[]} data.scopes - Granted scopes.
 * @param {string} [data.codeChallenge] - PKCE code challenge (S256).
 * @param {string} [data.codeChallengeMethod] - PKCE method, must be 'S256'.
 * @param {string} [data.nonce] - Nonce for ID token binding.
 * @returns {void}
 */
export function storeCode(code, data) {
  const parts = splitCode(code);
  if (!parts) {
    logger.warn('Refusing to store a malformed authorization code', {
      component: 'AuthCodeStore'
    });
    return;
  }

  codeStore.set(parts.handle, {
    secret: parts.secret,
    data,
    expiresAt: Date.now() + CODE_TTL_MS
  });
}

/**
 * Consume a code held by this worker.
 *
 * @param {string} handle - Routing handle identifying the entry.
 * @param {string} secret - Secret half presented by the caller.
 * @returns {Object|null} The stored payload, or null if unknown, expired, or
 *   the presented secret does not match.
 */
function consumeLocal(handle, secret) {
  const entry = codeStore.get(handle);

  if (!entry) {
    logger.warn('Code not found', { component: 'AuthCodeStore' });
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    logger.warn('Code expired', { component: 'AuthCodeStore' });
    codeStore.delete(handle);
    return null;
  }

  if (!secretsMatch(secret, entry.secret)) {
    // A valid handle with the wrong secret is not an honest mistake; drop the
    // entry so a guessing loop gets one attempt per code, not many.
    logger.warn('Code secret mismatch - discarding code', { component: 'AuthCodeStore' });
    codeStore.delete(handle);
    return null;
  }

  codeStore.delete(handle);
  return entry.data;
}

/**
 * Retrieve and consume an authorization code (single-use, cluster-wide).
 *
 * Resolves against the worker that minted the code: consumed locally when this
 * process holds it, otherwise the owning worker is asked over the cluster bus.
 * Either way the code is destroyed by the read, so a second call returns null
 * (replay protection).
 *
 * @param {string} code - The authorization code to consume.
 * @returns {Promise<Object|null>} The data payload that was stored with the
 *   code, or null if the code is unknown, already used, or expired.
 */
export async function consumeCode(code) {
  const parts = splitCode(code);
  if (!parts) {
    logger.warn('Code not found', { component: 'AuthCodeStore' });
    return null;
  }

  const { handle, secret } = parts;

  if (codeStore.has(handle)) {
    return consumeLocal(handle, secret);
  }

  // Another worker minted it — that worker owns the single consumption.
  if (hasRemote(PRESENCE_KIND, handle)) {
    const reply = await request(
      CONSUME_CHANNEL,
      { handle, secret },
      { route: { kind: PRESENCE_KIND, key: handle }, timeoutMs: CONSUME_TIMEOUT_MS }
    );

    if (!reply) {
      // No answer: the owner died between announcing the code and being asked.
      // Its codes died with it, so this is a genuine invalid_grant.
      logger.warn('Code owner did not respond - treating code as invalid', {
        component: 'AuthCodeStore'
      });
      return null;
    }

    return reply.data ?? null;
  }

  logger.warn('Code not found', { component: 'AuthCodeStore' });
  return null;
}

/**
 * Generate a cryptographically random authorization code.
 *
 * Shape is `<handle>.<secret>`: a 32-character hex handle used for cluster
 * routing and a 64-character hex secret. 384 bits of entropy in total, well
 * past the RFC 6749 requirement that codes be unguessable. Codes are opaque to
 * clients, so the internal structure is not part of any contract.
 *
 * @returns {string} A new authorization code.
 */
export function generateCode() {
  const handle = crypto.randomBytes(HANDLE_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  return `${handle}.${secret}`;
}

/**
 * Remove all expired entries held by this worker.
 *
 * Called automatically by the cleanup interval. Exposed here only to
 * make it easy to trigger from tests without waiting for the timer.
 *
 * @returns {void}
 */
export function cleanup() {
  const now = Date.now();
  for (const [handle, entry] of codeStore.entries()) {
    if (now > entry.expiresAt) {
      codeStore.delete(handle);
    }
  }
}

// Serve consume requests for codes this worker minted. Returning `undefined`
// when the handle is not here matters: if the primary has already dropped the
// ownership entry the question is broadcast, and a non-owner answering "null"
// first would lose the race against the real owner's answer.
respond(CONSUME_CHANNEL, ({ handle, secret } = {}) => {
  if (!handle || !codeStore.has(handle)) return undefined;
  return { data: consumeLocal(handle, secret) };
});

// Periodic cleanup – runs in the background and does not prevent the
// Node.js process from exiting (unref) so tests finish cleanly.
const cleanupInterval = setInterval(cleanup, CLEANUP_INTERVAL_MS);

if (cleanupInterval.unref) {
  cleanupInterval.unref();
}
