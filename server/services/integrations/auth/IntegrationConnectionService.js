// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The connection service of the unified integrations (concept
 * `2026-10-20 Unified Integrations/04-architecture.md` §1.4 and §2): who is
 * connected to which installed integration, and the one place that connects,
 * refreshes, disconnects and resolves those connections — for Jira, the cloud
 * storage providers and per-user MCP servers alike.
 *
 * Named `IntegrationConnectionService` and placed here because
 * `services/oauth/ConnectionService.js` already exists for something else:
 * the OAuth clients users connected to iHub as an authorization server.
 *
 * **The index.** One record per (installation, principal) in the storage
 * namespace `integration-connections` (schema:
 * `validators/integrationConnectionSchema.js`): kind, status
 * (`active | expired | revoked | failed | needs-reconnect`), issuer, granted
 * scopes, expiry, last refresh and use, the last error code, the fingerprint
 * of the installation settings the credentials were issued under, and a
 * `secretRef` to the token file `TokenStorageService` has always kept. No token
 * is ever copied into the index.
 *
 * **Resolve.** {@link IntegrationConnectionService#resolve} answers "may this
 * principal run this installation, and with what": the principal's **own**
 * connection, or the shared service-account credential the admin configured
 * on the installation. Never another user's token: a lookup is by
 * (installation, principal id) and nothing else, and a personal OAuth grant is
 * never shared (decided 2026-10-31). iFinder and iAssistant resolve as `sso`
 * (identity from the user's own sign-in per request, nothing stored).
 *
 * **Fingerprint.** A connection whose installation no longer has the
 * fingerprint it was issued under (another endpoint, tenant, server URL or
 * client) is invalidated: its tokens are deleted and the user reconnects. A
 * token issued for one endpoint is never sent to another.
 *
 * **Refresh** is single-flight per connection on each worker, re-reads the
 * stored tokens first (another worker may have refreshed already), deletes
 * them only when the authorization server definitively refuses the refresh
 * token, and keeps them on network errors, 5xx, 429 and a client the admin
 * can fix (the call fails as "temporarily unavailable" instead).
 *
 * **Audit.** `connection.create` and `connection.revoke` entries (resource
 * `connection`) on every connect and disconnect.
 *
 * @module services/integrations/auth/IntegrationConnectionService
 */
import crypto from 'node:crypto';
import { requireStorage } from '../../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../../storage/namespaces.js';
import { logAudit } from '../../AuditLogService.js';
import logger from '../../../utils/logger.js';
import { isValidReturnUrl } from '../../../utils/oauthReturnUrl.js';
import { buildServerPath } from '../../../utils/basePath.js';
import { validateIntegrationConnection } from '../../../validators/integrationConnectionSchema.js';
import { createUnavailableError } from '../oauthRefreshError.js';
import {
  OAUTH_FLOW_ERROR_CODES,
  OAuthFlowError,
  OAuthUserClient,
  checkAuthorizationResponseIssuer,
  definitiveOAuthRejection,
  parseScope,
  unionScopes
} from './OAuthUserClient.js';
import { getOAuthFlowStore } from './oauthFlowStore.js';
import { deleteSecretFile } from './tokenSecrets.js';
import { describeInstallation } from './connectionProviders.js';
import {
  INTEGRATION_AUTH_REASONS,
  IntegrationAuthRequiredError,
  integrationAuthRequiredResult
} from './integrationAuthRequired.js';

const COMPONENT = 'IntegrationConnectionService';

export const CONNECTIONS_NAMESPACE = RUNTIME_NAMESPACES.integrationConnections;

/** Where the browser lands when no (valid) return URL was given. */
export const DEFAULT_RETURN_PATH = '/settings/integrations';

/** A failed "connected as" lookup is not repeated sooner than this. */
const ACCOUNT_LABEL_RETRY_MS = 10 * 60 * 1000;

/** `lastUsedAt` is written at most this often per connection. */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/** Statuses that mean "reconnect before use". */
const UNUSABLE_STATUSES = new Set(['expired', 'revoked', 'failed', 'needs-reconnect']);

/**
 * Transient refresh failures in a row after which the token endpoint is left
 * alone for a cooldown (doubling per further failure, at most
 * REFRESH_COOLDOWN_MAX_MS) instead of being asked again on every call.
 */
const REFRESH_FAILURE_BACKOFF_AFTER = 3;
/** Transient refresh failures in a row after which the connection is `failed` (reconnect). */
const REFRESH_FAILURE_GIVE_UP_AFTER = 10;
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MAX_MS = 60 * 60 * 1000;

/**
 * Whether a refused refresh ends the connection. `invalid_grant` always does,
 * and so does a refresh token bound to another client. `invalid_client` and
 * `unauthorized_client` are usually client problems an admin fixes (an
 * expired client secret) and keep the tokens — unless the server says the
 * refresh token is what it refuses: Atlassian answers a dead refresh token
 * with `403 unauthorized_client` "refresh_token is invalid", and treating
 * that as temporary would retry the dead token forever.
 *
 * @param {Error} error - What the refresh threw
 * @returns {string|null} The rejection that ends the connection, or null
 */
export function terminalRefreshRejection(error) {
  if (error?.errorCode === 'other_client') return 'other_client';
  const rejection = definitiveOAuthRejection(error);
  if (rejection === 'invalid_grant') return rejection;
  if (
    (rejection === 'unauthorized_client' || rejection === 'invalid_client') &&
    /refresh[\s_-]?token/i.test(error?.errorDescription || '')
  ) {
    return rejection;
  }
  return null;
}

/**
 * The id of the connection of a principal to an installation — a pure
 * function of the two, so connect, lazy indexing and resolve all name the same
 * record, and a lookup can never land on another principal's.
 *
 * @param {string} integration - Installation id
 * @param {{type: 'user', id: string} | {type: 'shared'}} principal
 * @returns {string} `conn_<40 hex>`
 */
export function connectionIdFor(integration, principal) {
  const who = principal?.type === 'user' ? `user:${principal.id}` : 'shared';
  const digest = crypto
    .createHash('sha256')
    .update(`${integration}\n${who}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `conn_${digest}`;
}

function isAnonymous(user) {
  return !user?.id || user.id === 'anonymous';
}

/** The return URL as a path on this origin, with query parameters set. */
export function returnPathWith(returnUrl, params = {}) {
  let url;
  try {
    url = new URL(String(returnUrl), 'https://ihub.invalid');
  } catch {
    url = new URL(buildServerPath(DEFAULT_RETURN_PATH), 'https://ihub.invalid');
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  // Path, query and fragment only, with leading slashes collapsed: the result
  // always starts with exactly one `/` and can never leave this origin.
  const pathPart = `${url.pathname}${url.search}${url.hash}`.replace(/^[/\\]+/, '');
  return `/${pathPart}`;
}

/**
 * The query parameters the browser comes back with after a sign-in, the same
 * for every protocol: `integration_connected=<installation id>` on success,
 * `integration_error=<code>&integration=<installation id>` on failure. `code`
 * is one of `OAUTH_FLOW_ERROR_CODES` (stable, never text from the
 * authorization server). The chat's Connect card and Settings → Integrations
 * read them (client `features/integrations/connect/connectResult.js`).
 *
 * @param {string|{installationId?: string}|null} descriptorOrId - The installation (id or descriptor)
 * @param {{ok: boolean, code?: string}} outcome
 * @returns {Record<string, string>}
 *
 * @example
 *   resultParams('jira', { ok: true });                  // { integration_connected: 'jira' }
 *   resultParams('jira', { ok: false, code: 'access_denied' });
 *   // { integration_error: 'access_denied', integration: 'jira' }
 */
export function resultParams(descriptorOrId, outcome) {
  const installationId =
    typeof descriptorOrId === 'string' ? descriptorOrId : descriptorOrId?.installationId || null;
  if (outcome.ok) return { integration_connected: installationId };
  return {
    integration_error: outcome.code || OAUTH_FLOW_ERROR_CODES.OAUTH_FAILED,
    ...(installationId ? { integration: installationId } : {})
  };
}

/**
 * @typedef {Object} ResolveResult
 * @property {boolean} ok
 * @property {'oauth-user'|'service-account'|'sso'} [kind]
 * @property {Object} [connection] - The connection record (no secret)
 * @property {IntegrationAuthRequiredError} [error] - When `ok` is false
 */

export class IntegrationConnectionService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.documents] - Document store; the storage provider's when omitted
   * @param {import('./oauthFlowStore.js').OAuthFlowStore} [options.flowStore]
   * @param {(installationId: string) => Promise<Object|null>} [options.describe] - Test seam
   * @param {(entry: Object) => void} [options.audit] - Audit writer (default: the audit log)
   * @param {() => number} [options.now]
   */
  constructor({ documents, flowStore, describe, audit, now = () => Date.now() } = {}) {
    this._documents = documents || null;
    this._flowStore = flowStore || null;
    this.describe = describe || describeInstallation;
    this.audit = audit || logAudit;
    this.now = now;
    /** @type {Map<string, Promise<Object>>} single-flight refreshes per connection id */
    this._refreshes = new Map();
    /** @type {Map<string, number>} failed "connected as" lookups per connection id */
    this.accountLabelFailures = new Map();
    /** Test seam: the SDK-style refresh function handed to the OAuth client. */
    this.refreshFn = null;
    /**
     * How long to wait before re-reading the stored tokens once more when the
     * authorization server refused a refresh token: a rotating refresh token
     * may just have been used by another worker, whose new tokens win.
     */
    this.refreshGraceMs = 250;
  }

  _docs() {
    return this._documents || requireStorage().documents;
  }

  _flows() {
    return this._flowStore || getOAuthFlowStore();
  }

  _iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  // ── Index ───────────────────────────────────────────────────────────────

  /**
   * One connection record by id, or null.
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async getConnection(id) {
    try {
      const doc = await this._docs().get(CONNECTIONS_NAMESPACE, id);
      return doc?.data || null;
    } catch (error) {
      logger.warn('Connection record could not be read', {
        component: COMPONENT,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Write a connection record (validated; an invalid one is logged and not written).
   * @param {Object} record
   * @param {{etag?: string}} [options] - `etag`: write only over the document with this etag
   *   (throws `ETAG_MISMATCH` when it changed meanwhile)
   * @returns {Promise<Object|null>} The stored record
   */
  async putConnection(record, { etag } = {}) {
    const now = this._iso();
    const candidate = {
      issuer: null,
      scopesGranted: [],
      externalAccount: null,
      expiresAt: null,
      lastRefreshedAt: null,
      lastUsedAt: null,
      error: null,
      fingerprint: null,
      ...record,
      createdAt: record.createdAt || now,
      updatedAt: now
    };
    const parsed = validateIntegrationConnection(candidate);
    if (!parsed.success) {
      logger.error('Refusing to store an invalid connection record', {
        component: COMPONENT,
        integration: record?.integration,
        issues: parsed.error.issues.map(issue => issue.path.join('.')).join(', ')
      });
      return null;
    }
    const stored = parsed.data;
    const ownerId = stored.principal.type === 'user' ? stored.principal.id : 'system';
    await this._docs().put(CONNECTIONS_NAMESPACE, stored.id, stored, {
      ownerId,
      ...(etag ? { etag } : {})
    });
    return stored;
  }

  /**
   * Write a connection record only when none exists (create-only, atomic in
   * the document store): lazy indexing uses it so a record a live connect or
   * refresh wrote meanwhile is never overwritten.
   *
   * @param {Object} record
   * @returns {Promise<{created: boolean, record: (Object|null)}>}
   */
  async createConnection(record) {
    const documents = this._docs();
    const now = this._iso();
    const parsed = validateIntegrationConnection({
      issuer: null,
      scopesGranted: [],
      externalAccount: null,
      expiresAt: null,
      lastRefreshedAt: null,
      lastUsedAt: null,
      error: null,
      fingerprint: null,
      ...record,
      createdAt: record.createdAt || now,
      updatedAt: now
    });
    if (!parsed.success) {
      logger.error('Refusing to store an invalid connection record', {
        component: COMPONENT,
        integration: record?.integration,
        issues: parsed.error.issues.map(issue => issue.path.join('.')).join(', ')
      });
      return { created: false, record: null };
    }
    const ownerId = parsed.data.principal.type === 'user' ? parsed.data.principal.id : 'system';
    try {
      await documents.put(CONNECTIONS_NAMESPACE, parsed.data.id, parsed.data, {
        ownerId,
        etag: null
      });
      return { created: true, record: parsed.data };
    } catch (error) {
      if (error?.code === 'ETAG_MISMATCH') {
        return { created: false, record: await this.getConnection(parsed.data.id) };
      }
      throw error;
    }
  }

  /**
   * Merge fields into a record; no-op when there is none.
   *
   * The merge is written only over the document it was computed from (etag
   * compare-and-set), retried on a fresh read when another worker wrote first:
   * a `lastUsedAt` touch computed from an old copy used to overwrite a status
   * (`expired`, revoked, an error) that had just been written.
   */
  async updateConnection(id, patch) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc = await this._docs().get(CONNECTIONS_NAMESPACE, id);
      if (!doc?.data) return null;
      try {
        return await this.putConnection({ ...doc.data, ...patch }, { etag: doc.etag });
      } catch (error) {
        if (error?.code !== 'ETAG_MISMATCH') throw error;
      }
    }
    throw Object.assign(new Error('Connection record kept changing'), { code: 'ETAG_MISMATCH' });
  }

  async _deleteConnection(id) {
    return this._docs().delete(CONNECTIONS_NAMESPACE, id);
  }

  /**
   * Connection records, filtered.
   *
   * @param {Object} [filter]
   * @param {string} [filter.integration] - Only this installation
   * @param {string} [filter.userId] - Only this user's (indexed read)
   * @returns {Promise<Object[]>}
   */
  async listConnections({ integration, userId } = {}) {
    const documents = this._docs();
    const keep = record =>
      record &&
      (!integration || record.integration === integration) &&
      (!userId || (record.principal?.type === 'user' && record.principal.id === userId));
    const out = [];
    let cursor = null;
    do {
      const page = await documents.list(CONNECTIONS_NAMESPACE, {
        limit: 1000,
        includeData: true,
        ...(userId ? { ownerId: userId } : {}),
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items || []) if (keep(doc.data)) out.push(doc.data);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  /**
   * Delete every connection record of a user (account deletion). The token
   * files are deleted by `TokenStorageService.deleteAllTokensForStorageIds`.
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async forgetUser(userId) {
    let removed = 0;
    for (const record of await this.listConnections({ userId })) {
      if (await this._deleteConnection(record.id)) removed += 1;
    }
    return removed;
  }

  /**
   * The index record for a user's tokens of an installation, created from the
   * token file when the index does not know it yet (a file that predates the
   * index, or one another worker just wrote). This is the only way a token file
   * written before the connection index existed gets a record: on its first use.
   *
   * @param {Object} descriptor
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async _ensureRecord(descriptor, userId) {
    const id = connectionIdFor(descriptor.installationId, { type: 'user', id: userId });
    const existing = await this.getConnection(id);
    if (existing) return existing;
    const located = await descriptor.secret.locate(userId);
    if (!located) return null;
    let stored = null;
    try {
      stored = await descriptor.secret.read(userId);
    } catch {
      stored = null;
    }
    const view = descriptor.secret.view(stored);
    if (!view) return null;
    // Create-only: `getConnection` also answers null when the read failed,
    // and another worker may index the same file now. An existing record
    // (a failed or expired one) is never overwritten with a fresh active one.
    const { record } = await this.createConnection(
      recordFromStored({
        descriptor,
        userId,
        located,
        view,
        now: this._iso()
      })
    );
    return record;
  }

  // ── Resolve ─────────────────────────────────────────────────────────────

  /**
   * The connection a principal runs an installation with.
   *
   * - `sso` installations (iFinder, iAssistant): always `ok`, nothing stored.
   * - A shared service account configured on the installation: `ok` with the
   *   shared connection (`secretRef: credential:<ref>`), for any principal.
   * - Per-user OAuth: the principal's own connection only. None, anonymous, a
   *   shared principal, an unusable status, a changed installation fingerprint
   *   or a missing required scope → `ok: false` with an
   *   {@link IntegrationAuthRequiredError} (`not_connected`, `expired`,
   *   `insufficient_scope`).
   *
   * @param {{type: 'user', id: string} | {type: 'shared'}} principal
   * @param {string} installationId
   * @param {Object} [options]
   * @param {string[]} [options.requiredScopes]
   * @returns {Promise<ResolveResult>}
   */
  async resolve(principal, installationId, { requiredScopes = [] } = {}) {
    const descriptor = await this.describe(installationId);
    const fail = (reason, message, connectUrl = descriptor?.connectUrl, scopes) => ({
      ok: false,
      error: new IntegrationAuthRequiredError({
        integration: installationId,
        reason,
        message,
        // `insufficient_scope` goes to the reconnect route (the error's default).
        connectUrl: reason === INTEGRATION_AUTH_REASONS.INSUFFICIENT_SCOPE ? undefined : connectUrl,
        scopes
      })
    });
    if (!descriptor || descriptor.enabled === false) {
      return fail(
        INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
        `The integration ${installationId} is not available`,
        null
      );
    }
    if (descriptor.kind === 'sso') {
      return {
        ok: true,
        kind: 'sso',
        connection: {
          id: connectionIdFor(installationId, principal),
          integration: installationId,
          principal,
          kind: 'sso',
          status: 'active',
          secretRef: null
        }
      };
    }
    if (descriptor.kind === 'service-account') {
      return {
        ok: true,
        kind: 'service-account',
        connection: await this._sharedRecord(descriptor)
      };
    }
    if (principal?.type !== 'user' || isAnonymous(principal)) {
      return fail(
        INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
        `Connect ${descriptor.displayName} to continue`
      );
    }
    const record = await this._ensureRecord(descriptor, principal.id);
    if (!record) {
      return fail(
        INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
        `Connect ${descriptor.displayName} to continue`
      );
    }
    // Disconnected (by the user, or an admin revoked it): connect, not reconnect.
    if (record.status === 'revoked') {
      return fail(
        INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
        `Connect ${descriptor.displayName} to continue`
      );
    }
    if (await this._invalidateIfRepointed(descriptor, record)) {
      return fail(
        INTEGRATION_AUTH_REASONS.EXPIRED,
        `${descriptor.displayName} changed its configuration. Please reconnect your account.`
      );
    }
    if (UNUSABLE_STATUSES.has(record.status)) {
      return fail(
        INTEGRATION_AUTH_REASONS.EXPIRED,
        `${descriptor.displayName} authentication expired. Please reconnect your account.`
      );
    }
    // The record alone is not a connection: the secret must still be there
    // (a token file removed by hand, or by another worker a moment ago).
    if (!(await descriptor.secret.locate(principal.id))) {
      await this.updateConnection(record.id, { status: 'revoked', error: 'secret_missing' });
      return fail(
        INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
        `Connect ${descriptor.displayName} to continue`
      );
    }
    const granted = new Set(record.scopesGranted || []);
    const missing = parseScope(requiredScopes).filter(scope => !granted.has(scope));
    if (granted.size > 0 && missing.length > 0) {
      return fail(
        INTEGRATION_AUTH_REASONS.INSUFFICIENT_SCOPE,
        `${descriptor.displayName} needs more permissions (${missing.join(', ')}). Please reconnect your account.`,
        undefined,
        // What a reconnect asks for: everything granted plus what is missing.
        unionScopes([...granted], missing)
      );
    }
    return { ok: true, kind: 'oauth-user', connection: record };
  }

  /** The (index) record of an installation's shared service account. */
  async _sharedRecord(descriptor) {
    const principal = { type: 'shared', groups: [] };
    const id = connectionIdFor(descriptor.installationId, principal);
    const secretRef = `credential:${descriptor.credentialRef}`;
    const existing = await this.getConnection(id);
    if (existing?.secretRef === secretRef) return existing;
    return (
      (await this.putConnection({
        id,
        integration: descriptor.installationId,
        principal,
        kind: 'service-account',
        status: 'active',
        secretRef,
        fingerprint: descriptor.fingerprint,
        createdAt: existing?.createdAt
      })) || { id, integration: descriptor.installationId, principal, kind: 'service-account' }
    );
  }

  /**
   * Invalidate a connection whose installation settings changed since its
   * credentials were issued (endpoint, tenant, server URL, client): delete the
   * tokens and mark it `needs-reconnect`.
   *
   * @returns {Promise<boolean>} True when it was (or already is) invalid
   */
  async _invalidateIfRepointed(descriptor, record) {
    if (!record.fingerprint || !descriptor.fingerprint) return false;
    if (record.fingerprint === descriptor.fingerprint) return false;
    if (record.status === 'needs-reconnect') return true;
    const userId = record.principal?.id;
    if (userId) await descriptor.secret?.remove(userId).catch(() => false);
    await this.updateConnection(record.id, {
      status: 'needs-reconnect',
      error: 'endpoint_changed'
    });
    logger.info('Integration connection invalidated: the installation was repointed', {
      component: COMPONENT,
      integration: record.integration,
      userId
    });
    return true;
  }

  /**
   * Invalidate every connection of an installation (it was removed or
   * repointed). The token files are deleted; the records say why.
   *
   * @param {string} installationId
   * @param {Object} [options]
   * @param {'needs-reconnect'|'revoked'} [options.status='needs-reconnect']
   * @returns {Promise<number>} How many connections were invalidated
   */
  async invalidateInstallation(installationId, { status = 'needs-reconnect' } = {}) {
    let count = 0;
    for (const record of await this.listConnections({ integration: installationId })) {
      if (record.principal?.type !== 'user' || UNUSABLE_STATUSES.has(record.status)) continue;
      // Exactly the file the record names: never a legacy fallback that may
      // belong to another installation.
      await deleteSecretFile(record.secretRef).catch(() => false);
      await this.updateConnection(record.id, { status, error: 'endpoint_changed' });
      count += 1;
    }
    return count;
  }

  // ── Connect ─────────────────────────────────────────────────────────────

  /**
   * Start a sign-in: check the user may connect, resolve the authorization
   * server through the installation's strategy, keep state + PKCE verifier
   * server-side (bound to the user and the installation) and return the
   * authorization URL to send the browser to.
   *
   * @param {Object} params
   * @param {string} params.installationId
   * @param {Object} params.user - Signed-in user (req.user)
   * @param {import('express').Request} params.req - For the redirect URI and the return URL check
   * @param {string} [params.returnUrl] - Validated here (http(s), same origin), else the default
   * @param {string[]} [params.scopes] - Step-up: scopes to add to what the user already granted
   * @param {string} [params.publicBase] - MCP: iHub's public base (callback and CIMD URLs)
   * @param {boolean} [params.trustedBase] - MCP: the base may replace a registration made for another
   * @returns {Promise<{authorizationUrl: URL, returnUrl: string, descriptor: Object}>}
   * @throws {OAuthFlowError}
   */
  async beginConnect({ installationId, user, req, returnUrl, scopes, publicBase, trustedBase }) {
    if (isAnonymous(user)) {
      throw new OAuthFlowError(OAUTH_FLOW_ERROR_CODES.USER_MISMATCH, 'No signed-in user');
    }
    const validatedReturnUrl = isValidReturnUrl(returnUrl, req)
      ? String(returnUrl)
      : buildServerPath(DEFAULT_RETURN_PATH);
    const descriptor = await this.describe(installationId);
    if (
      !descriptor ||
      descriptor.kind !== 'oauth-user' ||
      descriptor.enabled === false ||
      !(await descriptor.mayConnect(user))
    ) {
      throw new OAuthFlowError(
        OAUTH_FLOW_ERROR_CODES.INTEGRATION_NOT_FOUND,
        `No connectable integration ${installationId}`
      );
    }
    const userId = String(user.id);
    // A protocol that needs more from the request than the redirect URI (MCP:
    // the public base its callback and CIMD URLs are built on) says so itself.
    let ctx = { publicBase, trustedBase };
    if (!publicBase && typeof descriptor.connectContext === 'function') {
      const derived = await descriptor.connectContext(req, user);
      if (!derived) {
        throw new OAuthFlowError(
          OAUTH_FLOW_ERROR_CODES.DISCOVERY_FAILED,
          `The public URL of ${installationId} is unknown`
        );
      }
      ctx = derived;
    }
    const redirectUri = descriptor.redirectUri(req, ctx);
    let stepUp = null;
    if (Array.isArray(scopes) && scopes.length) {
      const existing = await this.getConnection(
        connectionIdFor(installationId, { type: 'user', id: userId })
      );
      stepUp = unionScopes(existing?.scopesGranted || [], scopes);
    }
    const client = new OAuthUserClient({ strategy: await descriptor.strategy() });
    const started = await client.startAuthorization({
      redirectUri,
      ...(stepUp ? { extraScopes: stepUp } : {}),
      ctx
    });
    const state = await this._flows().create({
      userId,
      installationId,
      stack: descriptor.stack,
      returnUrl: validatedReturnUrl,
      redirectUri,
      codeVerifier: started.codeVerifier,
      issuer: started.issuer,
      authorizationServerUrl: started.authorizationServerUrl,
      clientId: started.clientId,
      issRequired: started.issRequired,
      ...(started.resource ? { resource: started.resource } : {}),
      scopes: started.scopes,
      stepUp: Boolean(stepUp)
    });
    const authorizationUrl = new URL(started.authorizationUrl.href);
    authorizationUrl.searchParams.set('state', state);
    logger.info('Integration sign-in started', {
      component: COMPONENT,
      integration: installationId,
      userId
    });
    return { authorizationUrl, returnUrl: validatedReturnUrl, descriptor };
  }

  /**
   * Reconnect: a new sign-in for an installation, optionally asking for more
   * scopes (step-up: the union of what is granted and what is needed).
   * @param {Object} params - As {@link beginConnect}
   * @returns {Promise<{authorizationUrl: URL, returnUrl: string, descriptor: Object}>}
   */
  reconnect(params) {
    return this.beginConnect(params);
  }

  /**
   * Finish a sign-in at the one callback (or one of its vendor-registered
   * aliases): consume the server-side flow, check it is bound to the signed-in
   * user and (for an alias that names one) the installation, check RFC 9207
   * `iss`, exchange the code with the stored PKCE verifier, store the tokens
   * where the installation has always kept them and index the connection.
   *
   * Never throws: every outcome is a redirect to a same-origin path carrying
   * only stable codes.
   *
   * @param {Object} params
   * @param {import('express').Request} params.req
   * @param {Object} [params.alias] - What the callback path names
   * @param {string} [params.alias.installationId] - Per-installation alias
   * @param {string} [params.alias.stack] - Per-stack alias (`jira`, `mcp`)
   * @returns {Promise<{redirectTo: string, ok: boolean, code?: string}>}
   */
  async completeConnect({ req, alias = {} }) {
    const query = req.query || {};
    const state = typeof query.state === 'string' ? query.state : '';
    // Checked before the flow is consumed, so a callback in another session
    // or at another installation's alias cannot burn the owner's sign-in.
    const pending = await this._flows().peek(state);
    if (pending) {
      const wrongUser = isAnonymous(req.user) || String(req.user.id) !== pending.userId;
      const wrongAlias =
        (alias.installationId && alias.installationId !== pending.installationId) ||
        (alias.stack && alias.stack !== pending.stack);
      if (wrongUser || wrongAlias) {
        logger.warn('Integration OAuth callback for a different user or installation refused', {
          component: COMPONENT,
          integration: pending.installationId,
          reason: wrongUser ? 'user' : 'installation'
        });
        const target = {
          stack: pending.stack,
          installationId: pending.installationId,
          resultKey: (await this.describe(pending.installationId).catch(() => null))?.resultKey
        };
        const code = wrongUser
          ? OAUTH_FLOW_ERROR_CODES.USER_MISMATCH
          : OAUTH_FLOW_ERROR_CODES.INVALID_STATE;
        // The flow's return URL is only used for its owner.
        const returnUrl = wrongUser ? buildServerPath(DEFAULT_RETURN_PATH) : pending.returnUrl;
        return {
          ok: false,
          code,
          redirectTo: returnPathWith(returnUrl, resultParams(target, { ok: false, code }))
        };
      }
    }
    const consumed = await this._flows().consume(state);
    const fallbackStack = alias.stack || null;
    const failWith = (code, flow, descriptor) => {
      const target = descriptor || {
        stack: flow?.stack || fallbackStack,
        resultKey: alias.resultKey,
        installationId: flow?.installationId || alias.installationId
      };
      return {
        ok: false,
        code,
        redirectTo: returnPathWith(
          flow?.returnUrl || buildServerPath(DEFAULT_RETURN_PATH),
          resultParams(target, { ok: false, code })
        )
      };
    };

    if (!consumed.ok) {
      const code =
        consumed.reason === 'expired'
          ? OAUTH_FLOW_ERROR_CODES.STATE_EXPIRED
          : OAUTH_FLOW_ERROR_CODES.INVALID_STATE;
      const flow =
        consumed.flow && String(req.user?.id || '') === consumed.flow.userId ? consumed.flow : null;
      logger.warn('Integration OAuth callback with an unknown or expired state', {
        component: COMPONENT,
        reason: consumed.reason
      });
      const descriptor = flow ? await this.describe(flow.installationId).catch(() => null) : null;
      return failWith(code, flow, descriptor);
    }
    const { flow } = consumed;
    const descriptor = await this.describe(flow.installationId).catch(() => null);

    // Bound to the user who started the flow: completing it in another
    // session would attach one person's upstream account to another.
    if (isAnonymous(req.user) || String(req.user.id) !== flow.userId) {
      logger.warn('Integration OAuth callback for a different or no user refused', {
        component: COMPONENT,
        integration: flow.installationId
      });
      // The flow's return URL is only used for its owner.
      return failWith(OAUTH_FLOW_ERROR_CODES.USER_MISMATCH, null, {
        stack: flow.stack,
        resultKey: descriptor?.resultKey,
        installationId: flow.installationId
      });
    }
    // Bound to the installation: a code delivered to one installation's
    // callback cannot complete another's sign-in (mix-up).
    if (
      (alias.installationId && alias.installationId !== flow.installationId) ||
      (alias.stack && alias.stack !== flow.stack)
    ) {
      logger.warn('Integration OAuth callback for another installation refused', {
        component: COMPONENT,
        integration: flow.installationId
      });
      return failWith(OAUTH_FLOW_ERROR_CODES.INVALID_STATE, flow, descriptor);
    }
    // The grant is checked again: a group may have lost the installation
    // while the user was at the authorization server.
    if (
      !descriptor ||
      descriptor.kind !== 'oauth-user' ||
      descriptor.enabled === false ||
      !(await descriptor.mayConnect(req.user))
    ) {
      return failWith(OAUTH_FLOW_ERROR_CODES.INTEGRATION_NOT_FOUND, flow, descriptor);
    }
    if (query.error) {
      logger.info('Integration sign-in declined or failed at the authorization server', {
        component: COMPONENT,
        integration: flow.installationId,
        userId: flow.userId
      });
      return failWith(
        query.error === 'access_denied'
          ? OAUTH_FLOW_ERROR_CODES.ACCESS_DENIED
          : OAUTH_FLOW_ERROR_CODES.OAUTH_FAILED,
        flow,
        descriptor
      );
    }
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code) return failWith(OAUTH_FLOW_ERROR_CODES.MISSING_CODE, flow, descriptor);

    try {
      // RFC 9207: a present `iss` must name the issuer; a repeated parameter
      // is not a valid issuer.
      // Enforced where the issuer was discovered (MCP); the fixed-endpoint
      // providers have one authorization server per callback, and some of
      // them name their issuer differently from the configured tenant.
      if (descriptor.stack === 'mcp') {
        const iss =
          query.iss === undefined ? undefined : typeof query.iss === 'string' ? query.iss : '';
        checkAuthorizationResponseIssuer({
          iss,
          expectedIssuer: flow.issuer,
          issRequired: flow.issRequired
        });
      }
      const strategy = await descriptor.strategy();
      const client = new OAuthUserClient({ strategy });
      const { tokens } = await client.exchangeCode({
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
        expected: {
          authorizationServerUrl: flow.authorizationServerUrl,
          clientId: flow.clientId,
          ...(flow.resource ? { resource: flow.resource } : {})
        }
      });
      await this._storeIssued({ descriptor, flow, tokens, req });
    } catch (error) {
      const failure =
        error instanceof OAuthFlowError ? error.code : OAUTH_FLOW_ERROR_CODES.CALLBACK_FAILED;
      if (
        descriptor.stack === 'mcp' &&
        definitiveOAuthRejection(error?.cause) === 'invalid_client'
      ) {
        await this._clearMcpRegistration(descriptor);
      }
      logger.warn('Integration OAuth code exchange failed', {
        component: COMPONENT,
        integration: flow.installationId,
        userId: flow.userId,
        code: failure,
        error: error.message
      });
      return failWith(failure, flow, descriptor);
    }
    logger.info('Integration connected', {
      component: COMPONENT,
      integration: flow.installationId,
      userId: flow.userId
    });
    return {
      ok: true,
      redirectTo: returnPathWith(flow.returnUrl, resultParams(descriptor, { ok: true }))
    };
  }

  /** `invalid_client` at the token endpoint: the registration is dead for everybody. */
  async _clearMcpRegistration(descriptor) {
    try {
      const { default: mcpClientManager } = await import('../../mcp/McpClientManager.js');
      const registration = await mcpClientManager
        .clientRegistrations()
        .getFor(descriptor.serverConfig);
      if (registration && registration.source !== 'config') {
        await mcpClientManager.clientRegistrations().clear(descriptor.installationId);
      }
    } catch {
      /* best effort */
    }
  }

  /** Store freshly issued tokens, index the connection and audit it. */
  async _storeIssued({ descriptor, flow, tokens, req }) {
    const userId = flow.userId;
    const id = connectionIdFor(descriptor.installationId, { type: 'user', id: userId });
    const previousRecord = await this.getConnection(id);
    const wasConnected = Boolean(await descriptor.secret.locate(userId));
    if (!tokens.refreshToken) {
      logger.warn(
        'No refresh token issued; the user will reconnect when the access token expires',
        {
          component: COMPONENT,
          integration: descriptor.installationId
        }
      );
    }
    const binding = {
      issuer: flow.issuer,
      authorizationServerUrl: flow.authorizationServerUrl,
      clientId: flow.clientId,
      fingerprint: descriptor.fingerprint,
      ...(flow.resource ? { resource: flow.resource } : {})
    };
    const extras = descriptor.storedExtras ? await descriptor.storedExtras(tokens, null) : {};
    const payload = descriptor.secret.payloadFor(tokens, { previous: null, binding, extras });
    await descriptor.secret.write(userId, payload);
    const located = await descriptor.secret.locate(userId);
    const expiresAt = Number.isFinite(tokens.expiresIn)
      ? this._iso(this.now() + tokens.expiresIn * 1000)
      : null;
    const scopes = tokens.scope ? parseScope(tokens.scope) : flow.scopes || [];
    await this.putConnection({
      id,
      integration: descriptor.installationId,
      principal: { type: 'user', id: userId },
      kind: 'oauth-user',
      status: 'active',
      issuer: flow.issuer || descriptor.issuer || null,
      scopesGranted: scopes,
      externalAccount: externalAccountOf(tokens),
      expiresAt,
      lastRefreshedAt: this._iso(),
      lastUsedAt: previousRecord?.lastUsedAt || null,
      error: null,
      secretRef: located?.secretRef || descriptor.secret.ref(userId),
      fingerprint: descriptor.fingerprint,
      createdAt: previousRecord?.createdAt
    });
    this.audit({
      req,
      action: 'create',
      resource: 'connection',
      resourceId: `${descriptor.installationId}:${userId}`,
      summary: `Connected ${descriptor.displayName} (${descriptor.installationId})${flow.stepUp ? ' with additional scopes' : ''}`
    });
    await descriptor.onConnected?.({ userId, user: req?.user, wasConnected });
  }

  /**
   * "Connected as …": the label of the account a user's connection belongs to
   * (`externalAccount.label`). Read from the provider once — the first time
   * the user's integrations are listed after connecting — and then kept on
   * the record, so later listings never call the vendor. Not done during the
   * callback: connecting stays one token exchange.
   *
   * Best effort: a failure leaves the record without a label and is not
   * retried for {@link ACCOUNT_LABEL_RETRY_MS} on this worker.
   *
   * @param {Object} params
   * @param {string} params.installationId
   * @param {string} params.userId
   * @returns {Promise<string|null>} The label, or null
   */
  async ensureAccountLabel({ installationId, userId }) {
    const id = connectionIdFor(installationId, { type: 'user', id: userId });
    const record = await this.getConnection(id);
    if (!record || record.status !== 'active') return null;
    if (record.externalAccount?.label) return record.externalAccount.label;
    const failedAt = this.accountLabelFailures.get(id);
    if (failedAt && this.now() - failedAt < ACCOUNT_LABEL_RETRY_MS) return null;
    const descriptor = await this.describe(installationId);
    if (typeof descriptor?.accountLabel !== 'function') return null;
    try {
      const label = await descriptor.accountLabel(userId);
      if (typeof label !== 'string' || !label) throw new Error('No account label');
      const bounded = label.slice(0, 512);
      await this.updateConnection(id, {
        externalAccount: { ...(record.externalAccount || {}), label: bounded }
      });
      this.accountLabelFailures.delete(id);
      return bounded;
    } catch (error) {
      this.accountLabelFailures.set(id, this.now());
      logger.info('Could not read the account of a connection', {
        component: COMPONENT,
        integration: installationId,
        error: error.message
      });
      return null;
    }
  }

  // ── Use and refresh ─────────────────────────────────────────────────────

  /**
   * The user's stored tokens for an installation (Jira, cloud storage), as
   * the service has always read them (`{ accessToken, refreshToken, … }`),
   * refreshed when they expired (or when `forceRefresh` after a 401).
   *
   * @param {Object} params
   * @param {string} params.installationId
   * @param {string} params.userId
   * @param {boolean} [params.forceRefresh=false] - The API answered 401
   * @param {string} [params.usedAccessToken] - The token the 401 was for
   * @returns {Promise<Object>} The stored payload
   * @throws {IntegrationAuthRequiredError} `not_connected` | `expired`
   * @throws {Error} code `integration_unavailable` — refresh failed transiently, tokens kept
   */
  async getUserTokens({ installationId, userId, forceRefresh = false, usedAccessToken }) {
    const descriptor = await this.describe(installationId);
    if (!descriptor?.secret || descriptor.stack === 'mcp') {
      throw new IntegrationAuthRequiredError({
        integration: installationId,
        reason: INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
        message: `User not authenticated with ${descriptor?.displayName || installationId}`
      });
    }
    const notConnected = () =>
      new IntegrationAuthRequiredError({
        integration: installationId,
        reason: INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
        message: `User not authenticated with ${descriptor.displayName}`,
        connectUrl: descriptor.connectUrl
      });
    const stored = await descriptor.secret.read(userId);
    if (!descriptor.secret.view(stored)) throw notConnected();
    const record = await this._ensureRecord(descriptor, userId);
    if (record && (await this._invalidateIfRepointed(descriptor, record))) {
      throw expiredError(descriptor);
    }
    // An expired, revoked, failed or repointed connection is not used, even
    // while a token file is still on disk.
    if (record && UNUSABLE_STATUSES.has(record.status)) throw expiredError(descriptor);
    const expired = await descriptor.secret.expired(userId, stored);
    if (!expired && !forceRefresh) {
      await this._touch(record);
      return stored;
    }
    return this._refreshSingleFlight(descriptor, userId, usedAccessToken || stored.accessToken);
  }

  /**
   * Merge non-secret fields into a user's stored token payload (e.g. the
   * Nextcloud user name looked up after the sign-in). The tokens themselves
   * are never changed here.
   *
   * @param {Object} params
   * @param {string} params.installationId
   * @param {string} params.userId
   * @param {Object} params.patch - Fields to merge; token fields are ignored
   * @returns {Promise<boolean>} Whether a payload was updated
   */
  async patchStoredTokens({ installationId, userId, patch }) {
    const descriptor = await this.describe(installationId);
    if (!descriptor?.secret || descriptor.stack === 'mcp') return false;
    const stored = await descriptor.secret.read(userId);
    if (!descriptor.secret.view(stored)) return false;
    const { accessToken: _a, refreshToken: _r, binding: _b, ...safe } = patch || {};
    await descriptor.secret.write(userId, { ...stored, ...safe });
    return true;
  }

  /** Write `lastUsedAt` at most every LAST_USED_WRITE_INTERVAL_MS. */
  async _touch(record) {
    if (!record) return;
    const last = Date.parse(record.lastUsedAt || '') || 0;
    if (this.now() - last < LAST_USED_WRITE_INTERVAL_MS) return;
    await this.updateConnection(record.id, { lastUsedAt: this._iso() }).catch(() => null);
  }

  _refreshSingleFlight(descriptor, userId, usedAccessToken) {
    const id = connectionIdFor(descriptor.installationId, { type: 'user', id: userId });
    let pending = this._refreshes.get(id);
    if (!pending) {
      pending = this._refreshOnce(descriptor, userId, usedAccessToken).finally(() => {
        if (this._refreshes.get(id) === pending) this._refreshes.delete(id);
      });
      this._refreshes.set(id, pending);
    }
    return pending;
  }

  async _refreshOnce(descriptor, userId, usedAccessToken) {
    const id = connectionIdFor(descriptor.installationId, { type: 'user', id: userId });
    // Re-read first: another call or worker may have refreshed already.
    const current = await descriptor.secret.read(userId);
    const view = descriptor.secret.view(current);
    if (!view) {
      throw new IntegrationAuthRequiredError({
        integration: descriptor.installationId,
        reason: INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
        message: `User not authenticated with ${descriptor.displayName}`,
        connectUrl: descriptor.connectUrl
      });
    }
    if (
      usedAccessToken &&
      view.accessToken !== usedAccessToken &&
      !(await descriptor.secret.expired(userId, current))
    ) {
      return current;
    }
    if (!view.refreshToken) {
      await this._terminal(descriptor, userId, id, 'refresh_missing');
      throw expiredError(descriptor);
    }
    // Backing off after repeated transient failures: the token endpoint is
    // not asked again until the cooldown is over.
    const before = await this.getConnection(id);
    const retryAfter = Date.parse(before?.retryAfter || '');
    if (Number.isFinite(retryAfter) && retryAfter > this.now()) {
      throw createUnavailableError(
        descriptor.displayName,
        new Error('Token refresh is cooling down after repeated failures')
      );
    }
    let refreshed;
    try {
      const client = new OAuthUserClient({ strategy: await descriptor.strategy() });
      refreshed = await client.refresh({
        refreshToken: view.refreshToken,
        binding: view.binding || {},
        ...(this.refreshFn ? { refreshFn: this.refreshFn } : {})
      });
    } catch (error) {
      const rejection = terminalRefreshRejection(error);
      if (rejection) {
        // A rotating refresh token may just have been used by another
        // worker: its new tokens win, nothing is deleted.
        const latest = await this._tokensChangedSince(descriptor, userId, view);
        if (latest) return latest;
        await this._terminal(descriptor, userId, id, rejection);
        throw expiredError(descriptor);
      }
      await this._recordTransientFailure(id, before);
      logger.warn('Integration token refresh failed; keeping the tokens', {
        component: COMPONENT,
        integration: descriptor.installationId,
        userId,
        error: error.message
      });
      throw createUnavailableError(descriptor.displayName, error);
    }
    const extras = descriptor.storedExtras ? await descriptor.storedExtras(refreshed, current) : {};
    const payload = descriptor.secret.payloadFor(refreshed, {
      previous: current,
      binding: view.binding,
      extras
    });
    let written;
    try {
      written = await descriptor.secret.write(userId, payload);
    } catch (error) {
      // The refresh worked but could not be stored: the old tokens stay, the
      // next call refreshes again.
      logger.error('Refreshed integration tokens could not be stored', {
        component: COMPONENT,
        integration: descriptor.installationId,
        error: error.message
      });
      throw createUnavailableError(descriptor.displayName, error);
    }
    const located = await descriptor.secret.locate(userId);
    await this.putConnection({
      ...((await this.getConnection(id)) ||
        recordFromStored({
          descriptor,
          userId,
          located,
          view: descriptor.secret.view(written),
          now: this._iso()
        })),
      status: 'active',
      error: null,
      refreshFailures: 0,
      retryAfter: null,
      lastRefreshedAt: this._iso(),
      lastUsedAt: this._iso(),
      expiresAt: Number.isFinite(refreshed.expiresIn)
        ? this._iso(this.now() + refreshed.expiresIn * 1000)
        : null,
      ...(refreshed.scope ? { scopesGranted: parseScope(refreshed.scope) } : {}),
      secretRef: located?.secretRef || descriptor.secret.ref(userId)
    });
    logger.info('Integration tokens refreshed', {
      component: COMPONENT,
      integration: descriptor.installationId,
      userId
    });
    return written;
  }

  /**
   * The stored payload when its tokens changed since `view` was read (another
   * worker refreshed with a rotating refresh token), re-read once more after
   * {@link refreshGraceMs}; else null.
   */
  async _tokensChangedSince(descriptor, userId, view) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let latest = null;
      try {
        latest = await descriptor.secret.read(userId);
      } catch {
        latest = null;
      }
      const latestView = descriptor.secret.view(latest);
      if (
        latestView &&
        (latestView.refreshToken !== view.refreshToken ||
          latestView.accessToken !== view.accessToken)
      ) {
        return latest;
      }
      if (attempt === 0 && this.refreshGraceMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.refreshGraceMs));
      }
    }
    return null;
  }

  /**
   * Count a transient refresh failure: after REFRESH_FAILURE_BACKOFF_AFTER in
   * a row the token endpoint is left alone for a growing cooldown; after
   * REFRESH_FAILURE_GIVE_UP_AFTER the connection is `failed` and the user is
   * asked to reconnect. A successful refresh resets both.
   */
  async _recordTransientFailure(id, record) {
    const failures = (record?.refreshFailures || 0) + 1;
    const patch = { error: 'refresh_unavailable', refreshFailures: failures };
    if (failures >= REFRESH_FAILURE_GIVE_UP_AFTER) {
      patch.status = 'failed';
      patch.error = 'refresh_failing';
      patch.retryAfter = null;
    } else if (failures >= REFRESH_FAILURE_BACKOFF_AFTER) {
      const cooldown = Math.min(
        REFRESH_COOLDOWN_MS * 2 ** (failures - REFRESH_FAILURE_BACKOFF_AFTER),
        REFRESH_COOLDOWN_MAX_MS
      );
      patch.retryAfter = this._iso(this.now() + cooldown);
    }
    await this.updateConnection(id, patch).catch(() => null);
  }

  /** A refresh token that is gone for good: delete the tokens, mark the record. */
  async _terminal(descriptor, userId, id, reason) {
    const removed = await descriptor.secret.remove(userId).catch(() => false);
    await this.updateConnection(id, { status: 'expired', error: reason }).catch(() => null);
    await descriptor.onDisconnected?.({ userId, removed });
    logger.info('Integration refresh refused; the user must reconnect', {
      component: COMPONENT,
      integration: descriptor.installationId,
      userId,
      reason
    });
  }

  /**
   * Record what the MCP client manager did with a user's tokens (it owns the
   * per-user connection pool and drives the MCP refresh itself through
   * `mcpOAuthService.refreshUserTokens`).
   *
   * @param {Object} params
   * @param {string} params.installationId
   * @param {string} params.userId
   * @param {'refreshed'|'dropped'} params.event
   * @param {Object} [params.payload] - The stored payload after a refresh
   * @param {string} [params.reason] - Why the tokens were dropped
   * @returns {Promise<void>}
   */
  async recordMcpEvent({ installationId, userId, event, payload, reason }) {
    try {
      const id = connectionIdFor(installationId, { type: 'user', id: userId });
      if (event === 'refreshed') {
        const existing = await this.getConnection(id);
        if (!existing) return;
        const expiresIn = Number(payload?.expires_in);
        await this.putConnection({
          ...existing,
          status: 'active',
          error: null,
          lastRefreshedAt: this._iso(),
          ...(Number.isFinite(expiresIn)
            ? { expiresAt: this._iso(this.now() + expiresIn * 1000) }
            : {}),
          ...(typeof payload?.scope === 'string'
            ? { scopesGranted: parseScope(payload.scope) }
            : {})
        });
      } else if (event === 'dropped') {
        await this.updateConnection(id, { status: 'expired', error: reason || 'refused' });
      }
    } catch (error) {
      logger.warn('MCP connection event could not be indexed', {
        component: COMPONENT,
        integration: installationId,
        error: error.message
      });
    }
  }

  // ── Disconnect ──────────────────────────────────────────────────────────

  /**
   * Disconnect a user from an installation: revoke at the issuer when it has
   * a revocation endpoint (RFC 7009, best effort), delete the tokens, mark the
   * record `revoked`, audit `connection.revoke`.
   *
   * @param {Object} params
   * @param {string} params.installationId
   * @param {string} params.userId - Whose connection (the caller's own, or one an admin picked)
   * @param {import('express').Request} [params.req] - For the audit entry
   * @returns {Promise<{removed: boolean, revoked: boolean}>}
   */
  async disconnect({ installationId, userId, req }) {
    const descriptor = await this.describe(installationId);
    if (!descriptor || descriptor.kind !== 'oauth-user') return { removed: false, revoked: false };
    const id = connectionIdFor(installationId, { type: 'user', id: userId });
    let stored = null;
    try {
      stored = await descriptor.secret.read(userId);
    } catch {
      stored = null;
    }
    const view = descriptor.secret.view(stored);
    let revoked = false;
    if (view) {
      try {
        const client = new OAuthUserClient({ strategy: await descriptor.strategy() });
        // Never sent to a server or client the tokens were not issued by
        // (a repointed MCP server); they are still deleted locally.
        revoked = await client.revoke({ tokens: view, binding: view.binding || {} });
      } catch (error) {
        logger.warn('Upstream revocation skipped', {
          component: COMPONENT,
          integration: installationId,
          error: error.message
        });
      }
    }
    const removed = Boolean(await descriptor.secret.remove(userId).catch(() => false));
    const record = await this.getConnection(id);
    if (record) await this.updateConnection(id, { status: 'revoked', error: null });
    await descriptor.onDisconnected?.({ userId, removed });
    if (removed || record) {
      this.audit({
        req,
        action: 'revoke',
        resource: 'connection',
        resourceId: `${installationId}:${userId}`,
        summary: `Disconnected ${descriptor.displayName} (${installationId})${revoked ? ', revoked upstream' : ''}`
      });
    }
    logger.info('Integration disconnected', {
      component: COMPONENT,
      integration: installationId,
      userId,
      revoked
    });
    return { removed, revoked };
  }

  // ── Views ───────────────────────────────────────────────────────────────

  /**
   * The users connected to an installation, for the admin Connections dialog.
   * Revoked records are left out.
   *
   * @param {string} installationId
   * @returns {Promise<Array<{userId: string, status: string, createdAt: string|null, expiresAt: string|null, expired: boolean, lastUsedAt: string|null}>>}
   */
  async listUserConnections(installationId) {
    const records = await this.listConnections({ integration: installationId });
    return records
      .filter(record => record.principal?.type === 'user' && record.status !== 'revoked')
      .map(record => ({
        userId: record.principal.id,
        status: record.status,
        createdAt: record.createdAt || null,
        expiresAt: record.expiresAt || null,
        expired: UNUSABLE_STATUSES.has(record.status),
        lastUsedAt: record.lastUsedAt || null
      }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  /**
   * The structured tool result for a failed {@link resolve}.
   * @param {IntegrationAuthRequiredError} error
   * @param {Object} [extra]
   * @returns {Object}
   */
  authRequiredResult(error, extra = {}) {
    return integrationAuthRequiredResult({
      integration: error.integration,
      reason: error.reason,
      message: error.message,
      connectUrl: error.connectUrl || undefined,
      scopes: error.scopes || undefined,
      extra
    });
  }
}

function expiredError(descriptor) {
  return new IntegrationAuthRequiredError({
    integration: descriptor.installationId,
    reason: INTEGRATION_AUTH_REASONS.EXPIRED,
    message: `${descriptor.displayName} authentication expired. Please reconnect your account.`,
    connectUrl: descriptor.connectUrl
  });
}

function externalAccountOf(tokens) {
  const raw = tokens?.raw || {};
  if (typeof raw.user_id === 'string' && raw.user_id) return { id: raw.user_id };
  return null;
}

/**
 * The index record for an existing token file (lazy indexing, see `_ensureRecord`).
 *
 * @param {Object} params
 * @param {Object} params.descriptor
 * @param {string} params.userId
 * @param {{secretRef: string, createdAt: string|null, expiresAt: string|null}} params.located
 * @param {import('./connectionProviders.js').SecretView} params.view
 * @param {string} params.now
 * @returns {Object}
 */
export function recordFromStored({ descriptor, userId, located, view, now }) {
  const expiresAt = located?.expiresAt || null;
  const accessExpired = expiresAt ? Date.parse(expiresAt) <= Date.parse(now) : false;
  const binding = view?.binding || {};
  return {
    id: connectionIdFor(descriptor.installationId, { type: 'user', id: userId }),
    integration: descriptor.installationId,
    principal: { type: 'user', id: userId },
    kind: 'oauth-user',
    // An expired access token with a refresh token is still a connection.
    status: accessExpired && !view?.refreshToken ? 'expired' : 'active',
    issuer: binding.issuer || binding.authorizationServerUrl || descriptor.issuer || null,
    scopesGranted: parseScope(view?.scope),
    externalAccount: null,
    expiresAt,
    lastRefreshedAt: located?.createdAt || null,
    lastUsedAt: null,
    error: null,
    secretRef: located?.secretRef || descriptor.secret.ref(userId),
    // MCP tokens carry the fingerprint they were issued under; for the others
    // it is the installation's current one (the tokens were issued under it).
    fingerprint: binding.fingerprint || descriptor.fingerprint || null,
    createdAt: located?.createdAt || now
  };
}

let singleton = null;

/** The process-wide service. */
export function getIntegrationConnectionService() {
  if (!singleton) singleton = new IntegrationConnectionService();
  return singleton;
}

/** Test seam: replace the singleton. */
export function setIntegrationConnectionServiceForTests(service) {
  singleton = service;
}
