// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pending integration sign-ins, kept server-side.
 *
 * A sign-in spans two requests — the connect request sends the browser to the
 * authorization server, the callback receives the code — and in cluster mode
 * they land on different workers. What the callback needs is stored here, in
 * the storage namespace `integration-oauth-flows` that every worker shares,
 * and the browser only carries an opaque random `state`:
 *
 *   - the user and the installation the flow is bound to: a callback in
 *     another user's session, or for another installation, is refused;
 *   - the PKCE verifier, encrypted with the token store's key;
 *   - the redirect URI the authorization request sent (the token exchange
 *     must send the same), the issuer and client it went to, and whether the
 *     server promised an RFC 9207 `iss`;
 *   - the validated return URL.
 *
 * A record is **single use**: the callback consumes it by deleting it, and
 * only the request whose delete succeeded may go on, so a replayed or
 * duplicated callback finds nothing. Records live 15 minutes; expired ones
 * are swept opportunistically.
 *
 * The record is keyed by a hash of the state, so the namespace does not hold
 * the values a browser presents. Without a storage provider the store keeps
 * flows in this worker's memory (a single-process installation).
 *
 * @module services/integrations/auth/oauthFlowStore
 */
import crypto from 'node:crypto';
import cluster from 'node:cluster';
import { getStorage, readFacet } from '../../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../../storage/namespaces.js';
import tokenStorageService from '../../TokenStorageService.js';
import logger from '../../../utils/logger.js';

const COMPONENT = 'OAuthFlowStore';

export const OAUTH_FLOWS_NAMESPACE = RUNTIME_NAMESPACES.integrationOAuthFlows;

/** How long a started sign-in may take. */
export const OAUTH_FLOW_TTL_MS = 15 * 60 * 1000;

/** How often a worker sweeps expired flows at most. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Longest `state` a callback may present. */
const MAX_STATE_LENGTH = 512;

/**
 * @typedef {Object} OAuthFlow
 * @property {string} userId - The signed-in user who started the flow
 * @property {string} installationId
 * @property {string} stack - `jira` | `cloud-storage` | `mcp`
 * @property {string} returnUrl - Validated, same-origin
 * @property {string} redirectUri - Exactly what the authorization request sent
 * @property {string} codeVerifier - PKCE verifier (clear text once read back)
 * @property {string} issuer
 * @property {string} authorizationServerUrl
 * @property {string} clientId
 * @property {boolean} issRequired
 * @property {string} [resource]
 * @property {string[]} scopes - What the sign-in asked for
 * @property {number} exp - Epoch ms
 */

function keyFor(state) {
  return `flow_${crypto.createHash('sha256').update(String(state), 'utf8').digest('hex').slice(0, 48)}`;
}

export class OAuthFlowStore {
  /**
   * @param {Object} [options]
   * @param {Object|null} [options.documents] - Document store; `null` pins memory-only mode
   * @param {() => number} [options.now]
   */
  constructor({ documents, now = () => Date.now() } = {}) {
    this._documents = documents;
    this._pinned = documents !== undefined;
    this.now = now;
    /** @type {Map<string, Object>} */
    this.memory = new Map();
    this._lastSweep = 0;
  }

  _docs() {
    if (this._pinned) return this._documents || null;
    return readFacet(getStorage(), 'documents');
  }

  /**
   * Record a started sign-in and return the `state` that names it.
   *
   * @param {Omit<OAuthFlow, 'exp'>} flow
   * @returns {Promise<string>} The opaque `state` parameter
   */
  async create(flow) {
    for (const field of ['userId', 'installationId', 'returnUrl', 'redirectUri', 'codeVerifier']) {
      if (typeof flow?.[field] !== 'string' || !flow[field]) {
        throw new Error(`An OAuth flow needs a ${field}`);
      }
    }
    const state = crypto.randomBytes(32).toString('base64url');
    const record = {
      ...flow,
      codeVerifier: tokenStorageService.encryptString(flow.codeVerifier),
      exp: this.now() + OAUTH_FLOW_TTL_MS
    };
    const key = keyFor(state);
    const documents = this._docs();
    if (documents) {
      await documents.put(OAUTH_FLOWS_NAMESPACE, key, record, { ownerId: 'system' });
    } else {
      this._warnMemoryOnly();
      this.memory.set(key, record);
    }
    this._sweepSoon();
    return state;
  }

  /**
   * Without a storage provider the flows live in this worker's memory, which
   * another cluster worker (or pod) cannot read: a callback landing there
   * fails with `invalid_state`. Said once, loudly, when that can happen.
   */
  _warnMemoryOnly() {
    if (this._warned || !cluster.isWorker) return;
    this._warned = true;
    logger.warn(
      'No storage provider: integration sign-ins are kept in this worker only, so a callback that lands on another worker fails with invalid_state. Configure the storage provider (shared contents/) for cluster mode.',
      { component: COMPONENT }
    );
  }

  /**
   * The routing fields of the flow a `state` names (user, installation,
   * stack, return URL), without consuming it, or null. Lets the callback
   * refuse a request from another user or at another installation's alias
   * without burning the owner's sign-in.
   *
   * @param {string} state
   * @returns {Promise<{userId: string, installationId: string, stack: string, returnUrl: string}|null>}
   */
  async peek(state) {
    if (typeof state !== 'string' || !state || state.length > MAX_STATE_LENGTH) return null;
    const key = keyFor(state);
    const documents = this._docs();
    let record = null;
    if (documents) {
      try {
        record = (await documents.get(OAUTH_FLOWS_NAMESPACE, key))?.data || null;
      } catch {
        record = null;
      }
    } else {
      record = this.memory.get(key) || null;
    }
    if (!record) return null;
    return {
      userId: record.userId,
      installationId: record.installationId,
      stack: record.stack,
      returnUrl: record.returnUrl
    };
  }

  /**
   * Consume the flow a callback's `state` names: read it and delete it, so
   * no second request can use it. Expired flows are deleted and reported as
   * such.
   *
   * @param {string} state
   * @returns {Promise<{ok: true, flow: OAuthFlow} | {ok: false, reason: 'invalid'|'expired', flow?: OAuthFlow}>}
   *   `flow` on an expired result carries only the routing fields (no verifier)
   */
  async consume(state) {
    if (typeof state !== 'string' || !state || state.length > MAX_STATE_LENGTH) {
      return { ok: false, reason: 'invalid' };
    }
    const key = keyFor(state);
    const documents = this._docs();
    let record = null;
    if (documents) {
      try {
        const doc = await documents.get(OAUTH_FLOWS_NAMESPACE, key);
        record = doc?.data || null;
        if (record && !(await documents.delete(OAUTH_FLOWS_NAMESPACE, key))) {
          // Another request consumed it between our read and our delete.
          return { ok: false, reason: 'invalid' };
        }
      } catch (error) {
        logger.warn('OAuth flow lookup failed', { component: COMPONENT, error: error.message });
        return { ok: false, reason: 'invalid' };
      }
    } else {
      record = this.memory.get(key) || null;
      this.memory.delete(key);
    }
    if (!record) return { ok: false, reason: 'invalid' };
    const routing = {
      userId: record.userId,
      installationId: record.installationId,
      stack: record.stack,
      returnUrl: record.returnUrl
    };
    if (typeof record.exp !== 'number' || this.now() > record.exp) {
      return { ok: false, reason: 'expired', flow: routing };
    }
    let codeVerifier;
    try {
      codeVerifier = tokenStorageService.decryptString(record.codeVerifier);
    } catch {
      return { ok: false, reason: 'invalid', flow: routing };
    }
    return { ok: true, flow: { ...record, codeVerifier } };
  }

  /** Sweep expired flows at most every SWEEP_INTERVAL_MS, never blocking the caller. */
  _sweepSoon() {
    const now = this.now();
    if (now - this._lastSweep < SWEEP_INTERVAL_MS) return;
    this._lastSweep = now;
    this.sweep().catch(error =>
      logger.debug?.('OAuth flow sweep failed', { component: COMPONENT, error: error.message })
    );
  }

  /**
   * Delete every expired flow.
   * @returns {Promise<number>} How many were removed
   */
  async sweep() {
    const now = this.now();
    const documents = this._docs();
    let removed = 0;
    if (!documents) {
      for (const [key, record] of this.memory) {
        if (!(record?.exp > now)) {
          this.memory.delete(key);
          removed += 1;
        }
      }
      return removed;
    }
    let cursor = null;
    do {
      const page = await documents.list(OAUTH_FLOWS_NAMESPACE, {
        limit: 500,
        includeData: true,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items || []) {
        if (!(doc?.data?.exp > now) && (await documents.delete(OAUTH_FLOWS_NAMESPACE, doc.key))) {
          removed += 1;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return removed;
  }
}

let singleton = null;

/** The process-wide store. */
export function getOAuthFlowStore() {
  if (!singleton) singleton = new OAuthFlowStore();
  return singleton;
}

/** Test seam: replace the singleton. */
export function setOAuthFlowStoreForTests(store) {
  singleton = store;
}
