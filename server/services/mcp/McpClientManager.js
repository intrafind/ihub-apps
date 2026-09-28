import { McpServerConnection } from './McpServerConnection.js';
import {
  mcpServersFileSchema,
  mcpServerConfigSchema
} from '../../validators/mcpServerConfigSchema.js';
import { DEFAULT_MAX_FILE_SIZE_MB, resolveFileInputs } from './mcpFileInputs.js';
import { appsEnabledFor } from './mcpApps.js';
import {
  isAuthRequiredError,
  isTokenRefreshError,
  McpAuthRequiredError,
  McpUserOAuthProvider
} from './McpUserOAuthProvider.js';
import { getMcpOAuthClientStore, registrationFingerprint } from './mcpOAuthClientStore.js';
import { getMcpToolCatalogStore } from './mcpToolCatalogStore.js';
import {
  accessTokenExpired,
  deleteServerTokens,
  deleteUserTokens,
  readUserTokens,
  readUserTokensFor
} from './mcpUserTokens.js';
import { resolveMcpPublicBase, mcpConnectPath } from './mcpOAuthPublicUrl.js';
import {
  buildAuthRequiredResult,
  isUserOAuthServer,
  refreshUserTokens,
  serverDisplayName
} from './mcpOAuthService.js';
import { isAdminUser, isAnonymousUser } from '../loop/runIdentity.js';
import logger from '../../utils/logger.js';

/** A per-user connection nobody used for this long is closed. */
export const USER_CONNECTION_IDLE_MS = 30 * 60 * 1000;
/** How often idle per-user connections are swept. */
const USER_CONNECTION_SWEEP_MS = 5 * 60 * 1000;
/** How long the in-memory copy of a per-user server's catalog is trusted before re-reading it. */
const CATALOG_REFRESH_MS = 60 * 1000;
/**
 * After a definitive refresh refusal, how long to wait before re-reading the
 * stored tokens once more: another worker that refreshed with the same
 * (rotating) refresh token a moment earlier may still be writing its result.
 */
const REFRESH_RACE_GRACE_MS = 250;

/**
 * Pool key of a user's connection to a server.
 * @param {string} serverId
 * @param {string} userId
 * @returns {string}
 */
export function userConnectionKey(serverId, userId) {
  return `${serverId}::${userId}`;
}

/**
 * Keys iHub adds to every tool call's params for its own tools (the chat's
 * identity, the acting user, the app config, workflow plumbing, the message's
 * attachments). They are never the model's arguments and must not leave iHub:
 * an external MCP server would otherwise receive the full user object, the
 * app configuration or every upload of the message.
 */
const IHUB_CONTEXT_KEYS = new Set([
  'chatId',
  'user',
  'appConfig',
  'passthrough',
  '_fileData',
  '_attachments'
]);

/**
 * `language` is a default iHub adds that the model may also set; it is
 * forwarded only when the tool actually declares it.
 */
const OPTIONAL_CONTEXT_KEYS = new Set(['language']);

/**
 * The arguments to send to an MCP server: the call's params minus iHub's own
 * context keys.
 *
 * @param {Object} params - Params as handed to `runTool`
 * @param {Object} [inputSchema] - The tool's JSON schema
 * @returns {Object}
 */
export function toMcpArguments(params, inputSchema) {
  const declared =
    inputSchema?.properties && typeof inputSchema.properties === 'object'
      ? inputSchema.properties
      : {};
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (IHUB_CONTEXT_KEYS.has(key)) continue;
    if (OPTIONAL_CONTEXT_KEYS.has(key) && !Object.hasOwn(declared, key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Slim down the internal tool representation for transport to the admin UI.
 * Drops the `_mcp` dispatch markers and keeps the human-facing fields.
 */
function summarizeTools(tools) {
  return (tools || []).map(t => ({
    name: t.name,
    originalName: t._mcp?.originalName ?? t.name,
    description: t.description || '',
    // MCP Apps: the view this tool renders, shown in the admin tool preview.
    ...(t._mcp?.ui?.resourceUri ? { uiResourceUri: t._mcp.ui.resourceUri } : {}),
    // Parameters that take a chat attachment (`format: "file"`).
    ...(t._mcp?.fileInputs?.length
      ? { fileInputs: t._mcp.fileInputs.map(({ name, array }) => ({ name, array })) }
      : {}),
    parameters: t.parameters || { type: 'object', properties: {} }
  }));
}

/**
 * Singleton that owns one McpServerConnection per configured MCP server.
 *
 * Per-user OAuth servers (`auth.type: "oauthUser"`) are different: the entry
 * in `connections` is a `catalogOnly` connection that never connects and
 * serves the server's shared tool catalog, while tool calls, MCP App views and
 * admin tests run on the calling user's own connection from `userConnections`
 * (`<serverId>::<userId>`, closed after USER_CONNECTION_IDLE_MS idle). A
 * caller without a token gets the structured `MCP_AUTH_REQUIRED` result —
 * never another user's connection. The caller is always `params.user`, which
 * every entry point sets from the authenticated request (never from caller
 * input, see `utils/toolCallContext.js`).
 *
 * Token refresh is iHub's, not the SDK's: on a 401 (or an access token known
 * to be expired) `_refreshUserTokens` refreshes once per (user, server) —
 * concurrent calls share the one refresh — and retries the call. Tokens are
 * deleted only when the authorization server definitively refuses them.
 *
 * Lifecycle:
 *   1. `initialize(config)` is called once after configCache loads
 *      mcpServers.json. It validates the file, builds connections (lazy
 *      connect on first use), and remembers the parsed config.
 *   2. `reload(config)` swaps in a new config diff-style — existing
 *      connections that no longer appear are disconnected; new ones are
 *      added; changed transport/auth triggers reconnect.
 *   3. `listAllTools()` aggregates `tools/list` across healthy connections.
 *   4. `callTool(prefixedName, args)` parses the prefix, looks up the
 *      owning server, and forwards.
 */
class McpClientManager {
  constructor() {
    this.connections = new Map(); // serverId -> McpServerConnection
    /** @type {Map<string, {conn: McpServerConnection, provider: McpUserOAuthProvider, serverId: string, userId: string, lastUsed: number}>} */
    this.userConnections = new Map();
    /** @type {Map<string, number>} serverId -> when its catalog was last read from the store */
    this.catalogLoadedAt = new Map();
    this.security = { blockPrivateIps: true, allowedHosts: [] };
    this.initialized = false;
    this._sweepTimer = null;
    // Resolved lazily; tests may replace them.
    this.catalogStore = null;
    this.clientStore = null;
    /** @type {Map<string, Promise<Object>>} In-flight token refreshes per (server, user). */
    this._refreshes = new Map();
    this.refreshGraceMs = REFRESH_RACE_GRACE_MS;
    /** Test seam: replaces the SDK's `refreshAuthorization`. */
    this.refreshAuthorization = null;
  }

  _catalogs() {
    return this.catalogStore || getMcpToolCatalogStore();
  }

  _clients() {
    return this.clientStore || getMcpOAuthClientStore();
  }

  /**
   * The per-server OAuth client registration store every sign-in, refresh
   * and revocation of this manager's servers uses.
   * @returns {import('./mcpOAuthClientStore.js').McpOAuthClientStore}
   */
  clientRegistrations() {
    return this._clients();
  }

  /** Build the manager's own connection for a server config. */
  _newSharedConnection(cfg) {
    return new McpServerConnection(cfg, this.security, {
      catalogOnly: isUserOAuthServer(cfg)
    });
  }

  /**
   * (Re)load the manager from a raw mcpServers.json object.
   */
  async initialize(rawConfig) {
    const parsed = mcpServersFileSchema.safeParse(rawConfig || { servers: [] });
    if (!parsed.success) {
      logger.error('Invalid mcpServers.json — refusing to load MCP client config', {
        component: 'McpClientManager',
        errors: parsed.error.issues
      });
      this.security = { blockPrivateIps: true, allowedHosts: [] };
      // Tear down any existing connections so a broken edit doesn't leave a
      // half-initialised manager in place.
      await this.shutdown();
      this.initialized = true;
      return;
    }

    this.security = parsed.data.security;
    const wanted = new Map(parsed.data.servers.map(s => [s.id, s]));

    // Remove connections that no longer exist or whose transport, auth type
    // (or the capabilities negotiated at connect) changed.
    for (const [id, conn] of this.connections) {
      const next = wanted.get(id);
      if (!next || connectionChanged(conn.config, next)) {
        await conn.disconnect();
        this.connections.delete(id);
      }
      if (isUserOAuthServer(conn.config)) await this._retireUserServer(conn.config, next);
    }

    // Create / update remaining connections.
    for (const [id, cfg] of wanted) {
      const existing = this.connections.get(id);
      if (existing) {
        // Same transport, just rewire auth/allowlist/timeout — no reconnect needed.
        existing.config = cfg;
        existing.toolsCache = null;
        existing.appToolsCache = null;
        existing.uiResourceCache.clear();
        this.catalogLoadedAt.delete(id);
        continue;
      }
      this.connections.set(id, this._newSharedConnection(cfg));
      this.catalogLoadedAt.delete(id);
    }

    this._startSweep();
    this.initialized = true;
    logger.info('McpClientManager initialised', {
      component: 'McpClientManager',
      serverCount: this.connections.size
    });
  }

  async shutdown() {
    this._stopSweep();
    await Promise.all(
      Array.from(this.connections.values()).map(c => c.disconnect().catch(() => {}))
    );
    this.connections.clear();
    await Promise.all(
      Array.from(this.userConnections.values()).map(e => e.conn.disconnect().catch(() => {}))
    );
    this.userConnections.clear();
    this.catalogLoadedAt.clear();
  }

  // ── per-user connections (auth.type "oauthUser") ──────────────────────

  /**
   * A per-user server was reconfigured or removed: close every user's pooled
   * connection; drop the client registration when the endpoint or auth block
   * changed, the tool catalog when the endpoint changed, and every user's
   * tokens when the server was removed or its endpoint / auth block (the
   * registration fingerprint) changed — tokens issued for the old endpoint
   * are never sent to a new one. (Tokens are also bound to that fingerprint,
   * so a change made while iHub was down is caught on read.)
   *
   * @param {Object} previous - The config the manager had
   * @param {Object|undefined} next - The new config, or undefined when removed
   */
  async _retireUserServer(previous, next) {
    const id = previous.id;
    const endpointChanged = !next || previous.transport?.url !== next.transport?.url;
    const authChanged =
      endpointChanged ||
      JSON.stringify(previous.transport) !== JSON.stringify(next.transport) ||
      JSON.stringify(previous.auth) !== JSON.stringify(next.auth);
    const tokensInvalid =
      !next ||
      !isUserOAuthServer(next) ||
      registrationFingerprint(previous) !== registrationFingerprint(next);
    if (authChanged) {
      await this._clients()
        .clear(id)
        .catch(() => {});
    }
    if (tokensInvalid) {
      const removed = await deleteServerTokens(id).catch(() => 0);
      if (removed > 0) {
        logger.info('MCP user tokens removed after the server was removed or repointed', {
          component: 'McpClientManager',
          serverId: id,
          removed
        });
      }
    }
    if (endpointChanged) {
      await this._catalogs()
        .clear(id)
        .catch(() => {});
    }
    if (!next || JSON.stringify(previous) !== JSON.stringify(next)) {
      await this._closeUserConnections(id);
    }
  }

  _startSweep() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => {
      this.sweepIdleUserConnections().catch(() => {});
    }, USER_CONNECTION_SWEEP_MS);
    this._sweepTimer.unref?.();
  }

  _stopSweep() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this._sweepTimer = null;
  }

  /**
   * Close per-user connections idle for longer than USER_CONNECTION_IDLE_MS.
   * @param {number} [now]
   * @returns {Promise<number>} How many were closed
   */
  async sweepIdleUserConnections(now = Date.now()) {
    let closed = 0;
    for (const [key, entry] of this.userConnections) {
      if (now - entry.lastUsed < USER_CONNECTION_IDLE_MS) continue;
      this.userConnections.delete(key);
      await entry.conn.disconnect().catch(() => {});
      closed += 1;
    }
    return closed;
  }

  async _closeUserConnections(serverId) {
    for (const [key, entry] of this.userConnections) {
      if (entry.serverId !== serverId) continue;
      this.userConnections.delete(key);
      await entry.conn.disconnect().catch(() => {});
    }
  }

  /**
   * Close one user's pooled connection, so the next call reconnects with the
   * tokens now on disk (after a sign-in or a disconnect).
   * @param {string} serverId
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async evictUserConnection(serverId, userId) {
    const key = userConnectionKey(serverId, userId);
    const entry = this.userConnections.get(key);
    if (!entry) return;
    this.userConnections.delete(key);
    await entry.conn.disconnect().catch(() => {});
  }

  /**
   * The pooled connection of `userId` to an `oauthUser` server, created on
   * first use. It connects lazily, with the user's own tokens.
   *
   * Synchronous between the pool lookup and the insert, so parallel calls
   * for the same (server, user) always share one connection. The server's
   * live config is used when the caller holds an older copy (a reload ran
   * while it awaited something).
   *
   * @param {Object} serverConfig
   * @param {string} userId
   * @param {Object} [options]
   * @param {boolean} [options.authoritativeCatalog=false] - This user's listings
   *   replace the shared catalog (admins); others only add to it
   * @returns {{conn: McpServerConnection, provider: McpUserOAuthProvider, serverId: string, userId: string, lastUsed: number, authoritativeCatalog: boolean}}
   */
  _userConnection(serverConfig, userId, { authoritativeCatalog = false } = {}) {
    const live = this.connections.get(serverConfig.id)?.config || serverConfig;
    const key = userConnectionKey(live.id, userId);
    const existing = this.userConnections.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      if (authoritativeCatalog) existing.authoritativeCatalog = true;
      return existing;
    }
    const provider = this._providerFor(live, userId);
    const entry = {
      conn: null,
      provider,
      serverId: live.id,
      userId,
      lastUsed: Date.now(),
      authoritativeCatalog
    };
    entry.conn = new McpServerConnection(live, this.security, {
      authProvider: provider,
      onToolsListed: rawTools => {
        this.saveCatalog(live, rawTools, { authoritative: entry.authoritativeCatalog }).catch(
          () => {}
        );
      }
    });
    this.userConnections.set(key, entry);
    return entry;
  }

  /** The OAuth provider for (server, user). Synchronous: no registration read. */
  _providerFor(serverConfig, userId) {
    return new McpUserOAuthProvider({
      serverConfig,
      userId,
      publicBase: resolveMcpPublicBase() || null,
      clientStore: this._clients()
    });
  }

  /**
   * The connection a caller uses for a server: the shared one for ordinary
   * servers, the caller's own for `oauthUser` servers. Prefer
   * {@link withUserConnection}, which also refreshes an expired token.
   *
   * @param {string} serverId
   * @param {Object} [user] - The caller (req.user / params.user)
   * @returns {Promise<McpServerConnection>}
   * @throws {McpAuthRequiredError} For an `oauthUser` server the caller has not connected
   */
  async connectionForUser(serverId, user) {
    const shared = this.getConnection(serverId);
    if (!shared) throw new Error(`MCP server not found: ${serverId}`);
    if (!isUserOAuthServer(shared.config)) return shared;
    if (isAnonymousUser(user)) throw new McpAuthRequiredError(serverId);
    const userId = String(user.id);
    if (!(await readUserTokensFor(userId, shared.config))) {
      throw new McpAuthRequiredError(serverId);
    }
    return this._userConnection(shared.config, userId, {
      authoritativeCatalog: isAdminUser(user)
    }).conn;
  }

  /**
   * Run `operation(conn)` on the connection the caller uses for a server:
   * the shared one for ordinary servers; for an `oauthUser` server the
   * caller's own, refreshing the token when it is expired or rejected and
   * retrying once.
   *
   * @template T
   * @param {string} serverId
   * @param {Object} user - The authenticated caller
   * @param {(conn: McpServerConnection) => Promise<T>} operation
   * @returns {Promise<T>}
   * @throws {McpAuthRequiredError} The caller must (re)connect
   * @throws {import('./McpUserOAuthProvider.js').McpTokenRefreshError} Transient refresh failure
   */
  async withUserConnection(serverId, user, operation) {
    const shared = this.getConnection(serverId);
    if (!shared) throw new Error(`MCP server not found: ${serverId}`);
    if (!isUserOAuthServer(shared.config)) return operation(shared);
    if (isAnonymousUser(user)) throw new McpAuthRequiredError(serverId);
    return this._withUserConnection(shared.config, user, operation);
  }

  /**
   * The per-user core of {@link withUserConnection}.
   *
   * @param {Object} serverConfig - `oauthUser` server
   * @param {Object} user - Non-anonymous caller
   * @param {Function} operation
   * @param {Object} [options]
   * @param {McpServerConnection} [options.connection] - Use this connection
   *   (an admin probe) instead of the pooled one
   * @param {boolean} [options.authoritativeCatalog] - The listing replaces the
   *   shared catalog; default: whether the caller is an admin
   */
  async _withUserConnection(
    serverConfig,
    user,
    operation,
    { connection, authoritativeCatalog = isAdminUser(user) } = {}
  ) {
    const serverId = serverConfig.id;
    const userId = String(user.id);
    let stored = await readUserTokensFor(userId, serverConfig);
    if (!stored?.access_token) throw new McpAuthRequiredError(serverId);
    if (stored.refresh_token && accessTokenExpired(stored)) {
      stored = await this._refreshUserTokens(serverConfig, userId, stored.access_token);
    }
    const conn =
      connection || this._userConnection(serverConfig, userId, { authoritativeCatalog }).conn;
    const evict = async () => {
      if (!connection) await this.evictUserConnection(serverId, userId);
    };
    try {
      return await operation(conn);
    } catch (error) {
      if (!isAuthRequiredError(error)) throw error;
    }
    // The server rejected the token: refresh (or learn that another call
    // already did) and retry once.
    let fresh;
    try {
      fresh = await this._refreshUserTokens(serverConfig, userId, stored.access_token);
    } catch (error) {
      // Transient failures keep the connection (and the tokens) for the retry.
      if (isAuthRequiredError(error)) await evict();
      throw error;
    }
    try {
      return await operation(conn);
    } catch (error) {
      if (!isAuthRequiredError(error)) throw error;
      // Even a fresh token is refused: it is useless for this server.
      await this._dropUserTokens(serverConfig, userId, fresh.access_token);
      await evict();
      logger.info('MCP user token rejected after a refresh; sign-in required', {
        component: 'McpClientManager',
        serverId,
        userId
      });
      throw new McpAuthRequiredError(serverId);
    }
  }

  /**
   * Refresh a user's tokens for a server — at most one refresh per
   * (server, user) at a time; concurrent callers share its result.
   *
   * @param {Object} serverConfig
   * @param {string} userId
   * @param {string} usedAccessToken - The access token the caller sent
   * @returns {Promise<Object>} The current token payload
   * @throws {McpAuthRequiredError} The user must connect again
   * @throws {import('./McpUserOAuthProvider.js').McpTokenRefreshError} Transient failure
   */
  _refreshUserTokens(serverConfig, userId, usedAccessToken) {
    const key = userConnectionKey(serverConfig.id, userId);
    let pending = this._refreshes.get(key);
    if (!pending) {
      pending = this._refreshOnce(serverConfig, userId, usedAccessToken).finally(() => {
        if (this._refreshes.get(key) === pending) this._refreshes.delete(key);
      });
      this._refreshes.set(key, pending);
    }
    return pending;
  }

  async _refreshOnce(serverConfig, userId, usedAccessToken) {
    const serverId = serverConfig.id;
    // Re-read first: another call or worker may have refreshed already.
    const current = await readUserTokensFor(userId, serverConfig);
    if (!current?.access_token) throw new McpAuthRequiredError(serverId);
    if (usedAccessToken && current.access_token !== usedAccessToken) return current;
    if (!current.refresh_token) {
      // Nothing to renew the rejected access token with.
      await this._dropUserTokens(serverConfig, userId, current.access_token);
      throw new McpAuthRequiredError(serverId);
    }
    try {
      return await refreshUserTokens({
        serverConfig,
        userId,
        current,
        security: this.security,
        clientStore: this._clients(),
        ...(this.refreshAuthorization ? { refresh: this.refreshAuthorization } : {})
      });
    } catch (error) {
      if (isTokenRefreshError(error)) {
        logger.warn('MCP token refresh failed; keeping the tokens', {
          component: 'McpClientManager',
          serverId,
          userId,
          error: error.message
        });
        throw error;
      }
      if (!error?.rejection) throw error;
      // Definitively refused. A rotating refresh token may have just been
      // used by another worker, whose new tokens win.
      const latest = await this._tokensChangedSince(serverConfig, userId, current.access_token);
      if (latest) return latest;
      await this._dropUserTokens(serverConfig, userId, current.access_token);
      if (error.rejection === 'invalid_client' && error.source !== 'config') {
        await this._clients()
          .clear(serverId)
          .catch(() => {});
      }
      logger.info('MCP token refresh refused; sign-in required', {
        component: 'McpClientManager',
        serverId,
        userId,
        reason: error.rejection
      });
      throw error;
    }
  }

  /** The stored tokens when they no longer hold `accessToken` (re-read after a short grace), else null. */
  async _tokensChangedSince(serverConfig, userId, accessToken) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const latest = await readUserTokensFor(userId, serverConfig);
      if (latest?.access_token && latest.access_token !== accessToken) return latest;
      if (attempt === 0 && this.refreshGraceMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.refreshGraceMs));
      }
    }
    return null;
  }

  /** Delete a user's tokens, but only while they still hold `accessToken`. */
  async _dropUserTokens(serverConfig, userId, accessToken) {
    const current = await readUserTokens(userId, serverConfig.id);
    if (!current || (accessToken && current.access_token !== accessToken)) return false;
    await deleteUserTokens(userId, serverConfig.id).catch(() => false);
    logger.info('MCP user tokens invalidated', {
      component: 'McpClientManager',
      serverId: serverConfig.id,
      userId
    });
    return true;
  }

  /**
   * Forget iHub's OAuth client registration for a per-user server (admin
   * action): the next sign-in registers afresh.
   * @param {string} serverId
   * @returns {Promise<void>}
   */
  async resetClientRegistration(serverId) {
    await this._clients().clear(serverId);
    await this._closeUserConnections(serverId);
  }

  /**
   * The relative path a user opens to connect a server.
   * @param {string} serverId
   * @returns {string}
   */
  connectUrlFor(serverId) {
    return mcpConnectPath(serverId);
  }

  /**
   * Make the shared catalog of an `oauthUser` server available on its
   * `catalogOnly` connection, re-reading the store at most every
   * CATALOG_REFRESH_MS (another worker may have listed tools since).
   *
   * @param {McpServerConnection} conn
   * @returns {Promise<void>}
   */
  async _ensureCatalog(conn) {
    const id = conn.config.id;
    const loadedAt = this.catalogLoadedAt.get(id);
    if (loadedAt && Date.now() - loadedAt < CATALOG_REFRESH_MS) return;
    let record = null;
    try {
      record = await this._catalogs().get(id);
    } catch {
      record = null;
    }
    if (record && record.endpoint && record.endpoint !== conn.config.transport?.url) record = null;
    if (record) conn.applyCatalog(record.tools);
    else if (!conn.toolsCache) conn.applyCatalog(null);
    this.catalogLoadedAt.set(id, Date.now());
  }

  /**
   * Store a user connection's `tools/list` result in the server's shared
   * catalog.
   *
   * Policy (the upstream may list different tools to different users): an
   * authoritative listing — an admin's connection or Test connection —
   * replaces the catalog; anybody else's listing only adds tools the catalog
   * does not have yet, never removes or rewrites one. A user whose upstream
   * role sees fewer tools can therefore never shrink everybody's tool set.
   * Tools removed upstream disappear at the next admin Test connection (or
   * endpoint change). The upstream still authorizes every call with the
   * caller's own token, so a listed tool is no grant.
   *
   * @param {Object} serverConfig
   * @param {Object[]} rawTools
   * @param {Object} [options]
   * @param {boolean} [options.authoritative=false]
   * @returns {Promise<void>}
   */
  async saveCatalog(serverConfig, rawTools, { authoritative = false } = {}) {
    const endpoint = serverConfig.transport?.url || null;
    let tools = Array.isArray(rawTools) ? rawTools : [];
    if (!authoritative) {
      let record = null;
      try {
        record = await this._catalogs().get(serverConfig.id);
      } catch {
        record = null;
      }
      const existing =
        record && (!record.endpoint || record.endpoint === endpoint) && Array.isArray(record.tools)
          ? record.tools
          : [];
      if (existing.length > 0) {
        const known = new Set(existing.map(tool => tool?.name));
        const added = tools.filter(tool => tool?.name && !known.has(tool.name));
        if (added.length === 0) {
          this._applySharedCatalog(serverConfig.id, existing);
          return;
        }
        tools = [...existing, ...added];
      }
    }
    await this._catalogs().put(serverConfig.id, tools, { endpoint });
    this._applySharedCatalog(serverConfig.id, tools);
  }

  _applySharedCatalog(serverId, tools) {
    const shared = this.connections.get(serverId);
    if (shared && shared.catalogOnly) {
      shared.applyCatalog(tools);
      this.catalogLoadedAt.set(serverId, Date.now());
    }
  }

  /**
   * List tools on a user's connection (after a sign-in) so the server's
   * catalog is filled. Best effort.
   *
   * @param {string} serverId
   * @param {Object} user
   * @returns {Promise<Object[]|null>} The tools, or null when it failed
   */
  async refreshCatalogForUser(serverId, user) {
    try {
      return await this.withUserConnection(serverId, user, conn => conn.listTools());
    } catch (error) {
      logger.warn('MCP tool catalog refresh after sign-in failed', {
        component: 'McpClientManager',
        serverId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * The iHub tool definitions of one configured server (the shared catalog
   * for an `oauthUser` server), or an empty list.
   * @param {string} serverId
   * @returns {Promise<Object[]>}
   */
  async toolsOfServer(serverId) {
    const conn = this.connections.get(serverId);
    if (!conn) return [];
    try {
      return await this._serverTools(conn);
    } catch {
      return [];
    }
  }

  /**
   * The tools of one server as every consumer sees them. For `oauthUser`
   * servers this is the shared catalog; no connection is made.
   * @param {McpServerConnection} conn
   * @returns {Promise<Object[]>}
   */
  async _serverTools(conn) {
    if (conn.catalogOnly) {
      if (conn.config.enabled === false) return [];
      await this._ensureCatalog(conn);
    }
    return conn.listTools();
  }

  /**
   * Eagerly connect to every enabled server. Called once at server startup;
   * failures are swallowed so a single broken server doesn't block iHub
   * from coming up.
   */
  async connectAll() {
    if (!this.initialized) return;
    const tasks = [];
    for (const conn of this.connections.values()) {
      if (conn.config.enabled === false) continue;
      // Per-user servers have no connection of their own; load the catalog.
      if (conn.catalogOnly) {
        tasks.push(this._ensureCatalog(conn).catch(() => {}));
        continue;
      }
      tasks.push(
        conn.connect().catch(err => {
          logger.warn('Initial MCP connection failed; will retry lazily', {
            component: 'McpClientManager',
            serverId: conn.config.id,
            error: err.message
          });
        })
      );
    }
    await Promise.all(tasks);
  }

  /**
   * Aggregate `tools/list` across all healthy servers. Lazy-connects on
   * demand; failures from one server do not poison the result of others.
   */
  async listAllTools() {
    if (!this.initialized) return [];
    const all = [];
    await Promise.all(
      Array.from(this.connections.values()).map(async conn => {
        if (conn.config.enabled === false) return;
        try {
          const tools = await this._serverTools(conn);
          for (const t of tools) all.push(t);
        } catch (err) {
          logger.warn('MCP tools/list failed for server', {
            component: 'McpClientManager',
            serverId: conn.config.id,
            error: err.message
          });
        }
      })
    );
    // Deduplicate on tool id (across servers a duplicate is a config bug; we
    // keep the first to be deterministic).
    const seen = new Set();
    return all.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }

  /**
   * Whether an MCP server with this id is configured.
   * @param {string} serverId
   * @returns {boolean}
   */
  hasServer(serverId) {
    return this.connections.has(serverId);
  }

  /**
   * Resolve a prefixed tool id to its owning connection and tool definition.
   * @param {string} prefixedName - iHub tool id
   * @returns {Promise<{conn: McpServerConnection, tool: Object}|null>}
   */
  async findTool(prefixedName) {
    // We can't just split on the prefix because the prefix is per-server and
    // configurable. Iterate connections, ask each for its tool list, find a
    // match. Tool lists are cached in-memory so this is cheap.
    for (const conn of this.connections.values()) {
      if (conn.config.enabled === false) continue;
      let tools;
      try {
        tools = await this._serverTools(conn);
      } catch {
        continue;
      }
      const tool = tools.find(t => t.id === prefixedName);
      if (tool) return { conn, tool };
    }
    return null;
  }

  /**
   * Resolve a prefixed tool id back to its owning server and call it.
   * Throws if no connection produces a matching tool.
   *
   * iHub's context keys (`user`, `chatId`, `appConfig`, …) are stripped
   * before the call leaves iHub — see `toMcpArguments`. A tool with file
   * inputs gets the attachments of the current message (`params._attachments`)
   * resolved into FileData in their place, bounded by the server's
   * `fileInputs.maxFileSizeMB`; a caller without attachments (the inbound
   * gateway, A2A) gets a clear `MCP_FILE_*` error instead of a call.
   *
   * @param {string} prefixedName - iHub tool id
   * @param {Object} params - Params as handed to `runTool`
   * @param {Object} [options]
   * @param {Function} [options.onRawResult] - Receives the raw CallToolResult
   *   of a tool of a server with MCP Apps enabled: a tool that declares a view,
   *   or one whose result may embed a view page (see `findEmbeddedView`)
   */
  async callTool(prefixedName, params, { onRawResult } = {}) {
    const found = await this.findTool(prefixedName);
    if (!found) throw new Error(`MCP tool not found: ${prefixedName}`);
    const { conn, tool } = found;
    let args = toMcpArguments(params, tool.parameters);
    if (tool._mcp.fileInputs?.length) {
      const maxMb = conn.config.fileInputs?.maxFileSizeMB ?? DEFAULT_MAX_FILE_SIZE_MB;
      args = resolveFileInputs(args, tool._mcp.fileInputs, params?._attachments, {
        maxBytes: maxMb * 1024 * 1024,
        serverId: conn.config.id
      });
    }
    const callOptions =
      appsEnabledFor(conn.config) && typeof onRawResult === 'function' ? { onRawResult } : {};
    if (!isUserOAuthServer(conn.config)) {
      return conn.callTool(tool._mcp.originalName, args, callOptions);
    }
    return this._callUserTool(conn.config, tool, args, params, callOptions);
  }

  /**
   * A tool call on an `oauthUser` server, on the caller's own connection.
   * Without a user or a token the caller gets the structured auth-required
   * result (headless callers — gateway, A2A, workflows without a user —
   * included); there is no fallback to anybody else's connection. A refresh
   * that fails for a transient reason is an ordinary tool error: the tokens
   * are kept and the next call tries again.
   */
  async _callUserTool(serverConfig, tool, args, params, callOptions) {
    const user = params?.user;
    const language = params?.language;
    if (isAnonymousUser(user)) return buildAuthRequiredResult(serverConfig, language);
    try {
      return await this._withUserConnection(serverConfig, user, conn =>
        conn.callTool(tool._mcp.originalName, args, callOptions)
      );
    } catch (error) {
      if (isAuthRequiredError(error)) return buildAuthRequiredResult(serverConfig, language);
      if (isTokenRefreshError(error)) {
        throw new Error(
          `The sign-in to ${serverDisplayName(serverConfig, language)} could not be renewed right now (its authorization server did not answer). Try again in a moment.`
        );
      }
      throw error;
    }
  }

  /**
   * The connection for a configured server id, or null.
   * @param {string} serverId
   * @returns {McpServerConnection|null}
   */
  getConnection(serverId) {
    if (!this.initialized) return null;
    return this.connections.get(serverId) || null;
  }

  /**
   * Identify whether a given iHub tool id was sourced from MCP. toolLoader
   * uses this to decide which dispatch branch to take in `runTool`.
   */
  ownsTool(toolId) {
    if (!this.initialized) return false;
    for (const conn of this.connections.values()) {
      if (!conn.toolsCache) continue;
      if (conn.toolsCache.some(t => t.id === toolId)) return true;
    }
    return false;
  }

  /**
   * Snapshot used by the admin health dashboard.
   */
  status() {
    return Array.from(this.connections.values()).map(c => {
      const status = c.status();
      if (!c.catalogOnly) return status;
      // A per-user server is connected through its users' connections.
      let userConnections = 0;
      for (const entry of this.userConnections.values()) {
        if (entry.serverId === c.config.id && entry.conn.connected) userConnections += 1;
      }
      return { ...status, userConnections };
    });
  }

  /**
   * Per-server tool catalog used by the app editor's MCP picker. Unlike
   * `listAllTools` (which flattens + dedupes across servers) this preserves the
   * server grouping so the UI can present "tools from server X". Best-effort:
   * a server that fails tool discovery is returned with an `error` and an empty
   * tool list rather than poisoning the whole response.
   */
  async listToolsByServer() {
    if (!this.initialized) return [];
    const out = [];
    await Promise.all(
      Array.from(this.connections.values()).map(async conn => {
        const entry = {
          id: conn.config.id,
          name: conn.config.name || conn.config.id,
          ...(conn.config.description ? { description: conn.config.description } : {}),
          enabled: conn.config.enabled !== false,
          tools: [],
          error: null
        };
        if (conn.catalogOnly) entry.authType = 'oauthUser';
        if (entry.enabled) {
          try {
            entry.tools = summarizeTools(await this._serverTools(conn));
          } catch (err) {
            entry.error = err.message;
          }
        }
        out.push(entry);
      })
    );
    return out;
  }

  /**
   * Force-trigger a connection attempt on an already-configured server and
   * return its status plus the discovered tool catalog. Used by the admin
   * "Test connection" button on saved servers.
   */
  async testConnection(serverId, user = null) {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`MCP server not found: ${serverId}`);
    if (conn.catalogOnly) {
      // Test as the acting admin, with their own token; the listing replaces
      // the server's shared catalog (see saveCatalog).
      if (isAnonymousUser(user) || !(await readUserTokensFor(String(user.id), conn.config))) {
        return this._authRequiredTest(serverId);
      }
      await this.evictUserConnection(serverId, String(user.id));
      try {
        const result = await this._withUserConnection(
          conn.config,
          user,
          async userConn => {
            const tools = await userConn.listTools();
            return { status: userConn.status(), tools: summarizeTools(tools) };
          },
          { authoritativeCatalog: true }
        );
        return result;
      } catch (error) {
        if (isAuthRequiredError(error)) return this._authRequiredTest(serverId);
        throw error;
      }
    }
    await conn.disconnect();
    conn.consecutiveFailures = 0;
    conn.unhealthy = false;
    await conn.connect();
    const tools = await conn.listTools(); // also exercise tools/list
    return { status: conn.status(), tools: summarizeTools(tools) };
  }

  /** The admin test result for a per-user server the admin has not connected. */
  _authRequiredTest(serverId) {
    return {
      status: 'auth_required',
      connectUrl: this.connectUrlFor(serverId),
      tools: [],
      catalog: []
    };
  }

  /**
   * Probe an arbitrary (possibly unsaved) server config without registering
   * it. Used by the admin dialog so an operator can validate a connection and
   * preview the available tools before persisting the server. The ephemeral
   * connection is always torn down, even on failure, so no socket or child
   * process leaks.
   *
   * A per-user OAuth draft is probed with the acting admin's own token only
   * when its endpoint and auth block are exactly the saved server's: the
   * token was issued for that endpoint and must never reach an edited or new
   * URL. Otherwise the result asks to save first (`reason: 'unsaved_changes'`).
   * The probe never touches the shared registration or catalog.
   */
  async testConfig(rawServerConfig, user = null) {
    const parsed = mcpServerConfigSchema.safeParse(rawServerConfig);
    if (!parsed.success) {
      const err = new Error('Invalid server config');
      err.details = parsed.error.issues;
      throw err;
    }
    // Force-enable for the probe: the admin explicitly asked to test it, even
    // if they intend to leave the server disabled after saving. The probe lists
    // every tool the server offers, so the dialog can let the admin pick which
    // ones to allow; `tools` stays the allowlisted subset.
    const allow = parsed.data.allowedTools || ['*'];
    const allowAll = allow.includes('*');
    const probeConfig = { ...parsed.data, enabled: true, allowedTools: ['*'] };
    let saved = null;
    if (isUserOAuthServer(parsed.data)) {
      // Per-user server: probe with the acting admin's own token, and only
      // for exactly the saved endpoint and auth block.
      const current = this.connections.get(parsed.data.id)?.config;
      if (
        !current ||
        !isUserOAuthServer(current) ||
        registrationFingerprint(current) !== registrationFingerprint(parsed.data) ||
        JSON.stringify(current.transport) !== JSON.stringify(parsed.data.transport)
      ) {
        return { ...this._authRequiredTest(parsed.data.id), reason: 'unsaved_changes' };
      }
      if (isAnonymousUser(user) || !(await readUserTokensFor(String(user.id), current))) {
        return this._authRequiredTest(parsed.data.id);
      }
      saved = current;
    }
    const conn = new McpServerConnection(probeConfig, this.security, {
      ...(saved ? { authProvider: this._providerFor(saved, String(user.id)) } : {})
    });
    const probe = async () => {
      await conn.connect();
      const catalog = summarizeTools(await conn.listTools()).map(tool => ({
        ...tool,
        allowed: allowAll || allow.includes(tool.originalName)
      }));
      return {
        status: conn.status(),
        tools: catalog.filter(tool => tool.allowed).map(({ allowed: _allowed, ...tool }) => tool),
        catalog
      };
    };
    try {
      if (!saved) return await probe();
      return await this._withUserConnection(saved, user, probe, { connection: conn });
    } catch (error) {
      if (saved && isAuthRequiredError(error)) return this._authRequiredTest(parsed.data.id);
      throw error;
    } finally {
      await conn.disconnect().catch(() => {});
    }
  }
}

function connectionChanged(a, b) {
  return (
    JSON.stringify(a.transport) !== JSON.stringify(b.transport) ||
    (a.auth?.type || 'none') !== (b.auth?.type || 'none') ||
    (a.apps?.enabled !== false) !== (b.apps?.enabled !== false)
  );
}

const instance = new McpClientManager();
export default instance;
