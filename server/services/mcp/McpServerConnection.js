// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { URL } from 'node:url';
import { safeFetch, assertSafeHost } from './safeFetch.js';
import {
  appsEnabledFor,
  buildClientCapabilities,
  elicitationEnabledFor,
  extractUiResource,
  isAppCallable,
  isAppOnly,
  isModelVisible,
  readToolUiMeta
} from './mcpApps.js';
import {
  isAuthRequiredError,
  isTokenRefreshError,
  McpAuthRequiredError,
  withoutRedirects
} from './McpUserOAuthProvider.js';
import logger from '../../utils/logger.js';
import {
  ClientCredentialsTokenCache,
  clientCredentialsBody,
  resolveSecretRefs,
  staticAuthHeaders
} from '../integrations/auth/ServiceAccountAuth.js';
import { reportToolCallSources } from '../sources/toolCallScope.js';
import {
  ELICITATION_ANSWER_TIMEOUT_MS,
  createElicitationHandler,
  runWithElicitationScope
} from './mcpElicitation.js';

/**
 * Questions (MCP elicitation) a call may wait on before the SDK gives up on
 * it. The call's own timeout is paused while a person answers; this bounds
 * the whole call so a server cannot keep it open forever.
 */
const MAX_ELICITATION_ROUNDS = 3;

/** JSON-RPC code of "open these pages first" (URL elicitation required). */
const URL_ELICITATION_REQUIRED = -32042;

/**
 * The pages a server's `-32042` error asks the person to open before it will
 * run the call (at most three), or null for any other error.
 *
 * @param {*} error
 * @returns {Object[]|null} URL-mode elicitation params
 */
function pagesRequiredBy(error) {
  if (error?.code !== URL_ELICITATION_REQUIRED) return null;
  const pages = error.elicitations ?? error.data?.elicitations;
  if (!Array.isArray(pages)) return null;
  const valid = pages.filter(page => page && typeof page === 'object').slice(0, 3);
  return valid.length ? valid : null;
}

/** How long a fetched MCP App UI resource is reused before re-reading it. */
const UI_RESOURCE_TTL_MS = 5 * 60 * 1000;

/** Guard against a server that paginates `tools/list` forever. */
const MAX_TOOL_LIST_PAGES = 20;

/**
 * One MCPServerConnection wraps the SDK `Client` for a single configured
 * MCP server. It owns:
 *   - transport construction (streamableHttp, sse, stdio, websocket)
 *   - lazy connect on first use
 *   - exponential-backoff auto-reconnect
 *   - tool catalog cache (refreshed on `tools/list_changed`)
 *   - hard timeout + cancellation around `tools/call`
 *   - MCP Apps: advertising the `io.modelcontextprotocol/ui` extension,
 *     reading `_meta.ui` off tools, and fetching `ui://` resources
 *
 * Multiple servers are coordinated by McpClientManager.
 *
 * Per-user OAuth (`auth.type: "oauthUser"`): the manager builds one
 * connection per (server, user) and hands it an `authProvider`
 * (McpUserOAuthProvider) that the SDK transport uses for the bearer token,
 * refresh and re-consent. The manager's own connection for such a server is
 * `catalogOnly`: it never connects and answers `listTools` from the shared
 * tool catalog it is given with `applyCatalog`.
 */
export class McpServerConnection {
  /**
   * @param {Object} serverConfig - Parsed `mcpServers.json` entry
   * @param {Object} [security] - `{ blockPrivateIps, allowedHosts }`
   * @param {Object} [options]
   * @param {import('@modelcontextprotocol/client').OAuthClientProvider} [options.authProvider] -
   *   Per-user OAuth provider for the HTTP transports
   * @param {boolean} [options.catalogOnly=false] - Never connect; serve tools from `applyCatalog`
   * @param {(rawTools: Object[]) => void} [options.onToolsListed] - Receives every successful
   *   `tools/list` result (the manager persists it as the server's catalog)
   */
  constructor(
    serverConfig,
    security = {},
    { authProvider, catalogOnly = false, onToolsListed, resolveSecret } = {}
  ) {
    this.config = serverConfig;
    this.security = security;
    this.authProvider = authProvider || null;
    // A draft test may bring its secret inline instead of a stored credential.
    this.resolveSecret = typeof resolveSecret === 'function' ? resolveSecret : null;
    /** The server's own `tools/list` result behind the current tool sets. */
    this.rawToolsCache = null;
    this.catalogOnly = catalogOnly === true;
    this.onToolsListed = typeof onToolsListed === 'function' ? onToolsListed : null;
    this.client = null;
    /** The `elicitation/create` handler while questions are on (mcpElicitation.js). */
    this.elicitation = null;
    /** Scopes of the tool calls running now (a question sent outside one finds it). */
    this._callsInFlight = new Set();
    this.transport = null;
    this.connected = false;
    this.connecting = null; // shared promise while a connect is in flight
    this.lastError = null;
    this.toolsCache = null; // model-facing tools from the last tools/list
    // MCP Apps: every tool an app (view) of this server may call, keyed by the
    // server's own tool name. Includes app-only tools the model never sees.
    this.appToolsCache = null;
    this.uiResourceCache = new Map(); // uri -> { resource, expiresAt }
    this.consecutiveFailures = 0;
    // Marked unhealthy after `maxRetries` consecutive failures. The manager
    // skips unhealthy connections in `listAllTools` so a broken server doesn't
    // poison aggregate tool discovery.
    this.unhealthy = false;
    /** Client-credentials tokens of `auth.type: "oauth"` (ServiceAccountAuth). */
    this._oauthTokens = new ClientCredentialsTokenCache();
  }

  /**
   * Resolve auth secrets from the central credential store. The auth block in
   * mcpServers.json carries only credentialRef pointers (`tokenRef`,
   * `passwordRef`, `clientSecretRef`, `valueRef`); the plaintext secret is
   * fetched here at connect time and inlined onto the returned auth object as
   * the field name the header builders expect (`token` / `password` /
   * `clientSecret` / `value`).
   */
  _resolveAuth(auth) {
    if (!auth) return { type: 'none' };
    // Per-user OAuth: the transport's authProvider supplies the token; a
    // pre-registered client's secret is resolved by that provider when a
    // token request needs it, never here.
    if (auth.type === 'oauthUser') return { type: 'oauthUser' };
    return resolveSecretRefs(
      auth,
      {
        tokenRef: 'token',
        passwordRef: 'password',
        clientSecretRef: 'clientSecret',
        valueRef: 'value'
      },
      {
        ...(this.resolveSecret ? { resolveSecret: this.resolveSecret } : {}),
        onError: (refField, err) =>
          logger.error('Failed to resolve MCP server auth secret from credential store', {
            component: 'McpServerConnection',
            serverId: this.config.id,
            field: refField,
            error: err.message
          })
      }
    );
  }

  /**
   * Build static auth headers for bearer/basic/header. OAuth is handled separately
   * (async, per-request, with caching) in _getAuthHeaders so token refresh
   * works without rebuilding the transport.
   */
  _buildAuthHeaders(auth) {
    if (auth?.type === 'oauth' || auth?.type === 'oauthUser') return {};
    return staticAuthHeaders(auth);
  }

  /**
   * Resolve the auth headers for a single request, fetching/refreshing an
   * OAuth client-credentials token when auth.type === 'oauth'. The token is
   * cached until shortly before expiry. The token endpoint goes through the
   * same SSRF-guarded fetch as every other outbound call.
   */
  async _getAuthHeaders(auth) {
    if (auth?.type !== 'oauth') return this._buildAuthHeaders(auth);

    const token = await this._oauthTokens.getToken('client-credentials', async () => {
      const resp = await safeFetch(
        auth.tokenUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: clientCredentialsBody({
            clientId: auth.clientId,
            clientSecret: auth.clientSecret,
            scope: auth.scope
          }).toString()
        },
        {
          allowHosts: this.security.allowedHosts,
          blockPrivateIps: this.security.blockPrivateIps !== false
        }
      );
      if (!resp.ok) {
        throw new Error(`OAuth token request to ${auth.tokenUrl} failed: ${resp.status}`);
      }
      return resp.json();
    });
    return { Authorization: `Bearer ${token}` };
  }

  async _buildTransport() {
    const t = this.config.transport;
    const auth = this._resolveAuth(this.config.auth);

    const blockPrivateIps = this.security.blockPrivateIps !== false;

    if (t.type === 'streamableHttp' || t.type === 'sse') {
      const url = new URL(t.url);
      // SSRF guard up-front. The transport will re-resolve later but our
      // pinned-IP fetch (safeFetch) refuses the connect if the resolved
      // address has shifted to a private range.
      await assertSafeHost(url.hostname, this.security.allowedHosts, blockPrivateIps);

      const requestInit = { headers: { ...t.headers, ...this._buildAuthHeaders(auth) } };
      const allowHosts = this.security.allowedHosts;

      // Use our DNS-pinned fetch as the SDK's underlying transport so the
      // socket can't be steered to a private IP between validation and connect.
      // Auth headers are resolved per request so OAuth client-credentials
      // tokens refresh transparently without rebuilding the transport.
      // The SDK passes a `Headers` instance that already carries the static
      // auth headers (lowercased, from requestInit). Auth headers are *set* on
      // it rather than spread next to it: a plain-object merge would send both
      // `authorization` and `Authorization`, which fetch joins into
      // "Bearer t, Bearer t".
      const pinnedFetch = async (input, init = {}) => {
        const headers = new Headers(init.headers);
        for (const [name, value] of Object.entries(await this._getAuthHeaders(auth))) {
          headers.set(name, value);
        }
        const response = await safeFetch(
          input,
          { ...init, headers: toPlainHeaders(headers) },
          {
            allowHosts,
            blockPrivateIps
          }
        );
        // Per-user OAuth: a 403 `insufficient_scope` challenge is remembered
        // on the provider, so the manager can ask the user to re-authorize
        // once with the union of the granted and the challenged scopes
        // instead of refreshing a token that cannot get more scopes.
        if (this.authProvider && response?.status === 403) {
          const challenge = response.headers?.get?.('www-authenticate');
          if (typeof challenge === 'string' && /insufficient_scope/i.test(challenge)) {
            this.authProvider.scopeChallenge = challenge;
          }
        }
        return response;
      };
      // Per-user OAuth: on a 401 the SDK's auth() runs OAuth discovery through
      // this same fetch. Those requests go to URLs the MCP server (or its
      // authorization server) names, so they are sent without following
      // redirects — the SSRF guard checks only the first URL. MCP requests to
      // the endpoint's own origin keep the default behaviour.
      const guardedOAuthFetch = withoutRedirects(pinnedFetch);
      const transportFetch = this.authProvider
        ? (input, init = {}) =>
            isOAuthSideRequest(input, url)
              ? guardedOAuthFetch(input, init)
              : pinnedFetch(input, init)
        : pinnedFetch;

      // Per-user OAuth: the SDK transport sets the bearer token and runs the
      // refresh / re-consent logic itself. `_getAuthHeaders` adds nothing for
      // this auth type, so the two never collide.
      const authOptions = this.authProvider ? { authProvider: this.authProvider } : {};

      if (t.type === 'streamableHttp') {
        const r = this.config.reconnect || {};
        return new StreamableHTTPClientTransport(url, {
          requestInit,
          fetch: transportFetch,
          ...authOptions,
          reconnectionOptions: {
            maxReconnectionDelay: r.maxDelayMs ?? 30000,
            initialReconnectionDelay: r.initialDelayMs ?? 1000,
            reconnectionDelayGrowFactor: r.growthFactor ?? 1.5,
            maxRetries: r.maxRetries ?? 5
          }
        });
      }

      // Legacy SSE transport. SSE in the 2025-03-26 spec has been superseded
      // by Streamable HTTP; we keep this for back-compat with older servers.
      return new SSEClientTransport(url, {
        requestInit,
        fetch: transportFetch,
        eventSourceInit: { fetch: pinnedFetch },
        ...authOptions
      });
    }

    if (t.type === 'websocket') {
      const url = new URL(t.url);
      await assertSafeHost(url.hostname, this.security.allowedHosts, blockPrivateIps);
      // Our own transport: the SDK's takes no TLS options, so it could not honor
      // ssl.domainWhitelist for a wss:// server behind a private CA.
      // Loaded on demand: only websocket servers need `ws`, and keeping it out of
      // the static graph keeps this module light for everything that imports it.
      const { McpWebSocketTransport } = await import('./McpWebSocketTransport.js');
      return new McpWebSocketTransport(url, {
        handshakeTimeoutMs: this.config.timeoutMs ?? 30000
      });
    }

    if (t.type === 'stdio') {
      // Stdio child process. We do not invoke a shell — args go straight to
      // execve, eliminating shell-injection risk. PATH is whatever the parent
      // process has; the operator chose to register this server.
      return new StdioClientTransport({
        command: t.command,
        args: t.args || [],
        env: t.env || {},
        cwd: t.cwd
      });
    }

    throw new Error(`Unknown MCP transport type: ${t?.type}`);
  }

  async connect() {
    if (this.catalogOnly) {
      // The shared entry of a per-user server has no token of its own.
      throw new McpAuthRequiredError(this.config.id);
    }
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        this.client = new Client(
          { name: 'ihub-apps', version: '1.0.0' },
          {
            capabilities: buildClientCapabilities(appsEnabledFor(this.config), {
              elicitation: elicitationEnabledFor(this.config)
            }),
            versionNegotiation: versionNegotiationFor(this.config.transport)
          }
        );
        this.elicitation = null;
        if (elicitationEnabledFor(this.config)) {
          this.elicitation = createElicitationHandler({
            serverId: this.config.id,
            serverName: this.config.name || this.config.id,
            soleCall: () =>
              this._callsInFlight.size === 1 ? this._callsInFlight.values().next().value : null
          });
          this.client.setRequestHandler('elicitation/create', this.elicitation);
          // A 2025-era server reports that the person finished on the page of
          // a URL-mode question; the question then ends without their Done.
          const elicitation = this.elicitation;
          this.client.setNotificationHandler('notifications/elicitation/complete', async n => {
            elicitation.complete(n?.params?.elicitationId);
          });
        }
        this.transport = await this._buildTransport();
        await this.client.connect(this.transport);
        // The server's own model guidance from `initialize` (MCP
        // `instructions`), shown and editable on the installation page and
        // added to the system prompt while the integration is active (#2974).
        const instructions = this.client.getInstructions?.();
        this.instructions =
          typeof instructions === 'string' && instructions.trim() ? instructions : null;
        this.connected = true;
        this.consecutiveFailures = 0;
        this.unhealthy = false;
        this.lastError = null;
        logger.info('MCP server connected', {
          component: 'McpServerConnection',
          serverId: this.config.id,
          transport: this.config.transport.type
        });

        // Refresh the tool list when the server signals a change (2025-era
        // connections; a 2026-07-28 server sends it only on a
        // `subscriptions/listen` stream, which this client does not open, so
        // there the catalog refreshes on reconnect).
        this.client.setNotificationHandler('notifications/tools/list_changed', async () => {
          this.toolsCache = null;
          this.appToolsCache = null;
        });
      } catch (err) {
        // A missing or rejected user token is not a server fault: it must not
        // count towards marking the server unhealthy for everybody.
        if (isAuthRequiredError(err) || isTokenRefreshError(err)) {
          await this._closeQuietly();
          throw err;
        }
        this.consecutiveFailures++;
        this.lastError = err.message || String(err);
        const r = this.config.reconnect || {};
        const max = r.maxRetries ?? 5;
        if (this.consecutiveFailures >= max) {
          this.unhealthy = true;
          logger.error('MCP server marked unhealthy after consecutive failures', {
            component: 'McpServerConnection',
            serverId: this.config.id,
            failures: this.consecutiveFailures,
            error: this.lastError
          });
        }
        throw err;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  /** Close a half-open client after a failed connect, keeping the caches. */
  async _closeQuietly() {
    try {
      await this.client?.close();
    } catch {
      /* already closed */
    }
    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        logger.warn('Error closing MCP client', {
          component: 'McpServerConnection',
          serverId: this.config.id,
          error: err.message
        });
      }
    }
    this.client = null;
    this.transport = null;
    this.connected = false;
    this.toolsCache = null;
    this.appToolsCache = null;
    this.uiResourceCache.clear();
  }

  /**
   * List tools advertised by this server, applying the allowlist filter.
   * Returns the raw `Tool` objects from the MCP spec, augmented with iHub's
   * prefix metadata so the caller can map back to this server in `runTool`.
   *
   * MCP Apps: a tool whose `_meta.ui.visibility` leaves out `"model"` is an
   * app-only helper (a view's refresh or save action) and is never offered to
   * the model; a tool with `_meta.ui.resourceUri` carries it on `_mcp.ui` so
   * the chat can render its view. Both kinds land in `appToolsCache`.
   */
  async listTools() {
    if (this.config.enabled === false) return [];
    if (this.catalogOnly) return this.toolsCache || [];
    if (this.unhealthy) return [];
    if (!this.connected) await this.connect();
    if (this.toolsCache) return this.toolsCache;

    const rawTools = [];
    let cursor;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const result = await this.client.listTools(cursor ? { cursor } : {});
      rawTools.push(...(result.tools || []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    const { tools, appTools } = this.buildToolSets(rawTools);
    this.toolsCache = tools;
    this.appToolsCache = appTools;
    this.rawToolsCache = rawTools;
    if (this.onToolsListed) {
      try {
        this.onToolsListed(rawTools);
      } catch (err) {
        logger.warn('MCP tools/list listener failed', {
          component: 'McpServerConnection',
          serverId: this.config.id,
          error: err.message
        });
      }
    }
    return tools;
  }

  /**
   * Serve `listTools` / `getAppTool` from a stored `tools/list` result
   * (the shared catalog of a per-user server) instead of a live connection.
   *
   * @param {Object[]|null} rawTools - Tools as the server listed them, or null for none
   */
  applyCatalog(rawTools) {
    if (!Array.isArray(rawTools)) {
      this.toolsCache = null;
      this.appToolsCache = null;
      this.rawToolsCache = null;
      return;
    }
    const { tools, appTools } = this.buildToolSets(rawTools);
    this.toolsCache = tools;
    this.appToolsCache = appTools;
    this.rawToolsCache = rawTools;
  }

  /**
   * Turn the server's `tools/list` result into the iHub tool definitions the
   * model is offered and the tools this server's MCP App views may call,
   * applying this connection's prefix, allowlist and MCP Apps settings.
   *
   * @param {Object[]} rawTools
   * @returns {{tools: Object[], appTools: Map<string, Object>}}
   */
  buildToolSets(rawTools) {
    // A blank prefix means the default: tools of two servers must never share
    // an id, and the admin form leaves the field empty to accept `<id>__`.
    const prefix = this.config.toolPrefix?.trim() || `${this.config.id}__`;
    const allow = this.config.allowedTools || ['*'];
    const allowAll = allow.includes('*');
    const deny = new Set(this.config.deniedTools || []);
    const appsEnabled = appsEnabledFor(this.config);

    const tools = [];
    const appTools = new Map();
    for (const t of rawTools || []) {
      if (!t || typeof t.name !== 'string') continue;
      // Visibility is honoured even with apps disabled: an app-only helper
      // must never reach the model. Only the view link is dropped.
      const meta = readToolUiMeta(t);
      const ui = meta && !appsEnabled ? { ...meta, resourceUri: null } : meta;
      const allowed = (allowAll || allow.includes(t.name)) && !deny.has(t.name);

      // The allowlist governs what the model is offered. App-only tools are
      // never offered to the model and exist only to serve this server's own
      // views, so they stay callable by those views regardless.
      if (appsEnabled && isAppCallable(ui) && (allowed || isAppOnly(ui))) {
        appTools.set(t.name, {
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          ...(t.title ? { title: t.title } : {}),
          ...(t.annotations ? { annotations: t.annotations } : {}),
          ui
        });
      }

      if (!allowed || !isModelVisible(ui)) continue;
      tools.push({
        // iHub-facing id; runMcpTool splits on the prefix delimiter.
        id: `${prefix}${t.name}`,
        name: `${prefix}${t.name}`,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
        // Internal markers so runTool knows how to dispatch.
        _mcp: {
          serverId: this.config.id,
          originalName: t.name,
          // The tool's human-readable title, when the server declares one.
          ...(typeof (t.title || t.annotations?.title) === 'string'
            ? { title: t.title || t.annotations.title }
            : {}),
          ...(this.config.name ? { serverName: this.config.name } : {}),
          ...(ui?.resourceUri ? { ui: { resourceUri: ui.resourceUri } } : {}),
          // What the server says about its own tool (`readOnlyHint`, …). Read
          // by the approval resolver as an untrusted side effect: shown, but
          // never allowed to relax a gate (#2945).
          ...(t.annotations && typeof t.annotations === 'object'
            ? { annotations: t.annotations }
            : {})
        }
      });
    }
    return { tools, appTools };
  }

  /**
   * The tool an app (view) of this server wants to call, or null when the app
   * may not call it: unknown, hidden from apps by its visibility, or blocked
   * by the allowlist.
   *
   * @param {string} name - The server's own tool name
   * @returns {Promise<Object|null>}
   */
  async getAppTool(name) {
    if (typeof name !== 'string' || !name) return null;
    await this.listTools();
    return this.appToolsCache?.get(name) || null;
  }

  /**
   * Invoke a tool and return the raw CallToolResult, `isError` included.
   * Wraps the SDK call in the server's hard timeout. This is what an MCP App
   * view receives; the model-facing `callTool` builds on it.
   *
   * The call's timeout is paused while the server waits for a person to
   * answer one of its questions (MCP elicitation): the person must not race
   * the server's timeout.
   *
   * @param {string} originalName - The server's own tool name
   * @param {Object} [args]
   * @param {Object} [context] - Where a question the server asks goes
   * @param {string} [context.chatId]
   * @param {Object} [context.user]
   * @param {string} [context.toolId]
   * @param {AbortSignal} [context.signal] - The turn's abort signal
   * @returns {Promise<Object>} CallToolResult
   */
  async callToolRaw(originalName, args, context = {}) {
    if (this.catalogOnly) throw new McpAuthRequiredError(this.config.id);
    if (this.unhealthy) {
      throw new Error(`MCP server ${this.config.id} is unhealthy: ${this.lastError}`);
    }
    if (this.config.enabled === false) {
      throw new Error(`MCP server ${this.config.id} is disabled`);
    }
    if (!this.connected) await this.connect();

    const timeoutMs = this.config.timeoutMs ?? 30000;
    const controller = new AbortController();
    // A timeout that stands still while a person answers a question.
    let timer = null;
    let remaining = timeoutMs;
    let startedAt = 0;
    let waiting = 0;
    const arm = () => {
      startedAt = Date.now();
      timer = setTimeout(() => controller.abort(), remaining);
    };
    const pause = () => {
      if (waiting++ > 0 || !timer) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    };
    const resume = () => {
      if (--waiting > 0 || controller.signal.aborted) return;
      arm();
    };
    const onTurnAbort = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) onTurnAbort();
    context.signal?.addEventListener?.('abort', onTurnAbort, { once: true });
    arm();
    const sdkTimeout = elicitationEnabledFor(this.config)
      ? timeoutMs + MAX_ELICITATION_ROUNDS * ELICITATION_ANSWER_TIMEOUT_MS
      : timeoutMs;
    // A question still open when the call ends — whatever ended it, the SDK's
    // own timeout included — is cancelled with it.
    const questions = new AbortController();
    const endQuestions = () => questions.abort();
    controller.signal.addEventListener('abort', endQuestions, { once: true });
    const callScope = {
      chatId: context.chatId,
      user: context.user,
      toolId: context.toolId,
      signal: questions.signal,
      onWaitStart: pause,
      onWaitEnd: resume
    };
    this._callsInFlight.add(callScope);
    try {
      return await runWithElicitationScope(callScope, () =>
        this._callWithPagesOpened(() =>
          this.client.callTool(
            { name: originalName, arguments: args || {} },
            { signal: controller.signal, timeout: sdkTimeout }
          )
        )
      );
    } finally {
      endQuestions();
      controller.signal.removeEventListener('abort', endQuestions);
      this._callsInFlight.delete(callScope);
      clearTimeout(timer);
      context.signal?.removeEventListener?.('abort', onTurnAbort);
    }
  }

  /**
   * Run a call; when the server refuses it until the person opens a page
   * (URL elicitation required, `-32042`), put each page to the person as a
   * URL-mode question and, once they are done on all of them, call again —
   * at most {@link MAX_ELICITATION_ROUNDS} times. A page they decline, or
   * nobody to ask, leaves the server's error as it is.
   *
   * @param {() => Promise<Object>} call
   * @param {number} [round] - Refusals answered so far
   * @returns {Promise<Object>}
   */
  async _callWithPagesOpened(call, round = 0) {
    try {
      return await call();
    } catch (error) {
      const pages = pagesRequiredBy(error);
      if (!pages || !this.elicitation || round >= MAX_ELICITATION_ROUNDS) throw error;
      // One page after the other: a person works through them in order.
      const allDone = await this._askForPages(pages);
      if (!allDone) throw error;
      return this._callWithPagesOpened(call, round + 1);
    }
  }

  /** Put each page to the person in turn; true once they are done with all. */
  async _askForPages([page, ...rest]) {
    if (!page) return true;
    const { action } = await this.elicitation({ params: { ...page, mode: 'url' } });
    return action === 'accept' && this._askForPages(rest);
  }

  /**
   * Invoke a tool. Wraps the SDK call in a hard timeout and translates the
   * MCP-spec `isError: true` success response into a thrown Error — without
   * this, every tool-level failure surfaces as a successful response with
   * garbage content in the model context (issue #1460 comment, gap #3).
   *
   * @param {string} originalName - The server's own tool name
   * @param {Object} [args]
   * @param {Object} [options]
   * @param {Function} [options.onRawResult] - Receives the raw CallToolResult
   *   before it is normalised or turned into an error (MCP Apps views need it)
   * @param {Object} [options.context] - Chat, user and abort signal of the call
   *   ({@link McpServerConnection#callToolRaw})
   */
  async callTool(originalName, args, { onRawResult, context } = {}) {
    const result = await this.callToolRaw(originalName, args, context);
    if (typeof onRawResult === 'function') onRawResult(result);

    // Critical: MCP returns tool-level failures as a successful JSON-RPC
    // response with `isError: true`. If we don't catch this here, the
    // model receives the error payload as if it were a normal tool result.
    if (result?.isError) {
      const message = extractErrorText(result) || `MCP tool ${originalName} returned isError`;
      const err = new Error(message);
      err.code = 'MCP_TOOL_ERROR';
      err.mcpResult = result;
      throw err;
    }

    // The model reads the content blocks only; sources the server put in
    // `structuredContent` would be lost with the rest of it.
    reportToolCallSources(result?.structuredContent?.sources);
    return normalizeToolResult(result);
  }

  /**
   * `resources/read` against this server, bounded by the server's timeout.
   * @param {string} uri
   * @returns {Promise<Object>} ReadResourceResult
   */
  async readResource(uri) {
    await this._ready();
    const timeoutMs = this.config.timeoutMs ?? 30000;
    return this.client.readResource({ uri }, { timeout: timeoutMs });
  }

  /** Connect unless connected; refuse an unhealthy or disabled server. */
  async _ready() {
    if (this.unhealthy) {
      throw new Error(`MCP server ${this.config.id} is unhealthy: ${this.lastError}`);
    }
    if (this.config.enabled === false) {
      throw new Error(`MCP server ${this.config.id} is disabled`);
    }
    if (!this.connected) await this.connect();
  }

  /** The skills side of the current client (MCP Skills extension), built once per client. */
  _skillsClient() {
    if (this._skills?.client !== this.client) {
      // An entry the server lists badly is left out, not the whole listing.
      this._skills = {
        client: this.client,
        skills: new SkillsClient(this.client, { skipInvalid: true })
      };
    }
    return this._skills.skills;
  }

  /**
   * The server's skills (MCP Skills extension, `skills/list`), or null when
   * the server does not declare the extension.
   *
   * @param {Object} [options]
   * @param {number} [options.maxAgeMs=0] - Reuse a listing of this
   *   connection at most this old; 0 asks the server
   *
   * @returns {Promise<{skills: Object[], invalid: Object[]}|null>}
   */
  async listSkills({ maxAgeMs = 0 } = {}) {
    await this._ready();
    const kept = this._skillListing;
    if (maxAgeMs > 0 && kept?.client === this.client && Date.now() - kept.at < maxAgeMs) {
      return kept.value;
    }
    const skills = this._skillsClient();
    let value = null;
    if (skills.supported) {
      const timeoutMs = this.config.timeoutMs ?? 30000;
      const listing = await skills.list({}, { timeout: timeoutMs });
      value = { skills: listing.skills, invalid: listing.invalid };
    }
    this._skillListing = { client: this.client, at: Date.now(), value };
    return value;
  }

  /**
   * Read one file of a skill and verify it against `skill` — the entry it is
   * checked against, which need not be the server's current one: a file that
   * is not in the entry, or whose size or digest differs, is refused
   * (`SkillVerificationError`).
   *
   * @param {Object} skill - A skill entry (`uri`, `frontmatter`, `resources`)
   * @param {string} [ref] - Path relative to the skill root; `SKILL.md` when absent
   * @returns {Promise<Object>} the SDK's `SkillFile`
   */
  async readSkillFile(skill, ref) {
    await this._ready();
    const timeoutMs = this.config.timeoutMs ?? 30000;
    return this._skillsClient().read(skill, ref, { timeout: timeoutMs });
  }

  /**
   * Fetch and validate an MCP App UI resource (`ui://…`), cached briefly so a
   * chat with several views of the same app reads it once.
   *
   * @param {string} uri
   * @returns {Promise<{uri:string, html:string, csp:Object, permissions:Object, prefersBorder:(boolean|null)}>}
   */
  async getUiResource(uri) {
    const cached = this.uiResourceCache.get(uri);
    if (cached && cached.expiresAt > Date.now()) return cached.resource;
    const resource = extractUiResource(await this.readResource(uri), uri);
    this.uiResourceCache.set(uri, { resource, expiresAt: Date.now() + UI_RESOURCE_TTL_MS });
    logger.info('MCP App UI resource loaded', {
      component: 'McpServerConnection',
      serverId: this.config.id,
      uri,
      bytes: Buffer.byteLength(resource.html, 'utf8'),
      // The specification asks hosts to keep an audit trail of the CSP a view
      // was granted.
      csp: resource.csp,
      permissions: Object.keys(resource.permissions)
    });
    return resource;
  }

  status() {
    return {
      id: this.config.id,
      enabled: this.config.enabled !== false,
      connected: this.connected,
      unhealthy: this.unhealthy,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      transport: this.config.transport.type,
      toolCount: this.toolsCache ? this.toolsCache.length : null,
      ...(this.config.auth?.type === 'oauthUser' ? { authType: 'oauthUser' } : {})
    };
  }
}

/**
 * How the client picks the protocol revision of a connection.
 *
 * Streamable HTTP probes with `server/discover` and speaks 2026-07-28 to a
 * server that answers it, falling back to the 2025 `initialize` handshake for
 * one that does not. The other transports keep the 2025 handshake: a probe
 * over stdio spawns a second, short-lived copy of the server process, and the
 * legacy SSE and WebSocket transports predate the 2026 revision.
 *
 * @param {Object} transport - The server's `transport` config
 * @returns {{mode: 'auto'|'legacy'}}
 */
export function versionNegotiationFor(transport) {
  return { mode: transport?.type === 'streamableHttp' ? 'auto' : 'legacy' };
}

/**
 * Whether a request of a per-user OAuth transport is OAuth discovery rather
 * than MCP traffic: another origin than the MCP endpoint, or a
 * `/.well-known/` document on it.
 *
 * @param {string|URL|Request} input
 * @param {URL} endpoint - The MCP endpoint URL
 * @returns {boolean}
 */
function isOAuthSideRequest(input, endpoint) {
  let target;
  try {
    target = new URL(
      typeof input === 'string' ? input : input?.url || input?.href || String(input)
    );
  } catch {
    return true;
  }
  return target.origin !== endpoint.origin || target.pathname.startsWith('/.well-known/');
}

/**
 * Request headers as a plain object. The SDK transports pass a `Headers`
 * instance (carrying `Accept: application/json, text/event-stream` and the
 * content type); spreading one yields `{}`, which dropped those headers and
 * made spec-compliant Streamable HTTP servers answer 406.
 *
 * @param {Headers|Object|Array|undefined} headers
 * @returns {Object<string, string>}
 */
export function toPlainHeaders(headers) {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function extractErrorText(result) {
  if (!result?.content) return '';
  for (const part of result.content) {
    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
  }
  return '';
}

/**
 * An embedded MCP App view (`ui://…` resource) in a tool result. It is for
 * the host to render, not for the model: a view page is tens of kilobytes of
 * HTML and script. The raw result, view included, still reaches the chat
 * through `onRawResult`.
 */
function isEmbeddedUiResource(part) {
  return (
    part?.type === 'resource' &&
    typeof part.resource?.uri === 'string' &&
    part.resource.uri.startsWith('ui://')
  );
}

function normalizeToolResult(result) {
  if (!result?.content) return result;
  // Most callers in iHub want a string. If the MCP response is a single text
  // block, surface it as-is; otherwise return the structured array so callers
  // that handle multi-modal output still get everything.
  const all = Array.isArray(result.content) ? result.content : [];
  const withoutViews = all.filter(part => !isEmbeddedUiResource(part));
  const parts = withoutViews.length ? withoutViews : all;
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text;
  return parts;
}
