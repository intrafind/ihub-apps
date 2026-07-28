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
 * next. A plain per-process Map therefore answers "code not found" on N-1 of
 * every N token exchanges, which surfaces to the client as
 * `invalid_grant: Authorization code is invalid or expired` — intermittently,
 * with no bad input anywhere.
 *
 * Replicating the code to every worker would fix the lookup and break the
 * security property: reading a code *consumes* it, and N copies means N
 * consumptions, i.e. no replay protection. So the code stays on the worker
 * that minted it, ownership is announced over the cluster bus
 * (`server/clusterBus.js`), and a worker that receives the token request asks
 * the owner to consume it. Exactly one process ever holds a given code, so
 * single-use remains atomic without any distributed agreement.
 *
 * ## What travels over the bus
 *
 * Only the SHA-256 of the code, never the code itself. The local map is keyed
 * by that hash too, so the raw credential never leaves the worker that minted
 * it and never appears in another process's memory — the same indexing
 * approach `refreshTokenStore.js` uses. A hash is a sufficient key because
 * finding a colliding code is as hard as guessing the 256-bit code.
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
 * Codes minted by *this* worker, keyed by SHA-256 of the code. Membership is
 * announced to the cluster so other workers can route a consume request here.
 *
 * @type {Map<string, { data: Object, expiresAt: number, used: boolean }>}
 */
const codeStore = createPresenceMap(PRESENCE_KIND);

/** Authorization codes expire after 10 minutes (RFC 6749 recommendation). */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Periodic cleanup runs every 5 minutes to remove stale entries. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Derive the store/presence key for a code.
 *
 * SHA-256 of the code value: an index key, not a password hash — the input is
 * 256 bits of CSPRNG output, so stretching would add cost and no strength.
 *
 * @param {string} code - The authorization code.
 * @returns {string} Lowercase hex digest.
 */
function codeKey(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex'); // lgtm[js/insufficient-password-hash] -- index key, not a stored password
}

/**
 * Store an authorization code with its associated request data.
 *
 * The data object should contain everything needed to validate a subsequent
 * token request: clientId, redirectUri, userId, scopes, codeChallenge,
 * codeChallengeMethod, and nonce.
 *
 * @param {string} code - The authorization code (random hex string).
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
  codeStore.set(codeKey(code), {
    data,
    expiresAt: Date.now() + CODE_TTL_MS,
    used: false
  });
}

/**
 * Consume a code held by this worker.
 *
 * @param {string} key - SHA-256 key of the code.
 * @returns {Object|null} The stored payload, or null if unknown/used/expired.
 */
function consumeLocal(key) {
  const entry = codeStore.get(key);

  if (!entry) {
    logger.warn('Code not found', { component: 'AuthCodeStore' });
    return null;
  }

  if (entry.used) {
    logger.warn('Code already used - possible replay attack', { component: 'AuthCodeStore' });
    codeStore.delete(key);
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    logger.warn('Code expired', { component: 'AuthCodeStore' });
    codeStore.delete(key);
    return null;
  }

  codeStore.delete(key);
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
  if (!code) {
    logger.warn('Code not found', { component: 'AuthCodeStore' });
    return null;
  }

  const key = codeKey(code);

  if (codeStore.has(key)) {
    return consumeLocal(key);
  }

  // Another worker minted it — that worker owns the single consumption.
  if (hasRemote(PRESENCE_KIND, key)) {
    const reply = await request(
      CONSUME_CHANNEL,
      { key },
      { route: { kind: PRESENCE_KIND, key }, timeoutMs: CONSUME_TIMEOUT_MS }
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
 * Returns a 64-character lowercase hex string (256 bits of entropy),
 * which satisfies the RFC 6749 requirement for unpredictable codes.
 *
 * @returns {string} 32-byte random value encoded as hex.
 */
export function generateCode() {
  return crypto.randomBytes(32).toString('hex');
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
  for (const [key, entry] of codeStore.entries()) {
    if (now > entry.expiresAt) {
      codeStore.delete(key);
    }
  }
}

// Serve consume requests for codes this worker minted. Returning `undefined`
// when the code is not here matters: if the primary has already dropped the
// ownership entry the question is broadcast, and a non-owner answering "null"
// first would lose the race against the real owner's answer.
respond(CONSUME_CHANNEL, ({ key } = {}) => {
  if (!key || !codeStore.has(key)) return undefined;
  return { data: consumeLocal(key) };
});

// Periodic cleanup – runs in the background and does not prevent the
// Node.js process from exiting (unref) so tests finish cleanly.
const cleanupInterval = setInterval(cleanup, CLEANUP_INTERVAL_MS);

if (cleanupInterval.unref) {
  cleanupInterval.unref();
}
