import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { URL } from 'url';
import credentialService from '../CredentialService.js';
import { safeFetch, assertSafeHost } from './safeFetch.js';
import {
  appsEnabledFor,
  buildClientCapabilities,
  extractUiResource,
  isAppCallable,
  isAppOnly,
  isModelVisible,
  readToolUiMeta
} from './mcpApps.js';
import logger from '../../utils/logger.js';

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
 */
export class McpServerConnection {
  constructor(serverConfig, security = {}) {
    this.config = serverConfig;
    this.security = security;
    this.client = null;
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
    const out = { ...auth };
    const refFields = {
      tokenRef: 'token',
      passwordRef: 'password',
      clientSecretRef: 'clientSecret',
      valueRef: 'value'
    };
    for (const [refField, plainField] of Object.entries(refFields)) {
      if (typeof out[refField] === 'string' && out[refField]) {
        try {
          out[plainField] = credentialService.resolveSecret(out[refField]);
        } catch (err) {
          logger.error('Failed to resolve MCP server auth secret from credential store', {
            component: 'McpServerConnection',
            serverId: this.config.id,
            field: refField,
            error: err.message
          });
          throw err;
        }
      }
    }
    return out;
  }

  /**
   * Build static auth headers for bearer/basic/header. OAuth is handled separately
   * (async, per-request, with caching) in _getAuthHeaders so token refresh
   * works without rebuilding the transport.
   */
  _buildAuthHeaders(auth) {
    if (!auth || auth.type === 'none') return {};
    if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` };
    if (auth.type === 'basic') {
      const creds = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { Authorization: `Basic ${creds}` };
    }
    if (auth.type === 'header') {
      return { [auth.headerName]: `${auth.valuePrefix || ''}${auth.value}` };
    }
    return {};
  }

  /**
   * Resolve the auth headers for a single request, fetching/refreshing an
   * OAuth client-credentials token when auth.type === 'oauth'. The token is
   * cached until shortly before expiry. The token endpoint goes through the
   * same SSRF-guarded fetch as every other outbound call.
   */
  async _getAuthHeaders(auth) {
    if (auth?.type !== 'oauth') return this._buildAuthHeaders(auth);

    const now = Date.now();
    if (this._oauthToken && this._oauthTokenExpiry > now + 5000) {
      return { Authorization: `Bearer ${this._oauthToken}` };
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret
    });
    if (auth.scope) body.set('scope', auth.scope);

    const resp = await safeFetch(
      auth.tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      },
      {
        allowHosts: this.security.allowedHosts,
        blockPrivateIps: this.security.blockPrivateIps !== false
      }
    );
    if (!resp.ok) {
      throw new Error(`OAuth token request to ${auth.tokenUrl} failed: ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.access_token) {
      throw new Error('OAuth token response missing access_token');
    }
    this._oauthToken = data.access_token;
    this._oauthTokenExpiry = now + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
    return { Authorization: `Bearer ${this._oauthToken}` };
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

      const requestInit = { headers: { ...(t.headers || {}), ...this._buildAuthHeaders(auth) } };
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
        return safeFetch(
          input,
          { ...init, headers: toPlainHeaders(headers) },
          {
            allowHosts,
            blockPrivateIps
          }
        );
      };

      if (t.type === 'streamableHttp') {
        const r = this.config.reconnect || {};
        return new StreamableHTTPClientTransport(url, {
          requestInit,
          fetch: pinnedFetch,
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
        fetch: pinnedFetch,
        eventSourceInit: { fetch: pinnedFetch }
      });
    }

    if (t.type === 'websocket') {
      const url = new URL(t.url);
      await assertSafeHost(url.hostname, this.security.allowedHosts, blockPrivateIps);
      return new WebSocketClientTransport(url);
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
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        this.client = new Client(
          { name: 'ihub-apps', version: '1.0.0' },
          { capabilities: buildClientCapabilities(appsEnabledFor(this.config)) }
        );
        this.transport = await this._buildTransport();
        await this.client.connect(this.transport);
        this.connected = true;
        this.consecutiveFailures = 0;
        this.unhealthy = false;
        this.lastError = null;
        logger.info('MCP server connected', {
          component: 'McpServerConnection',
          serverId: this.config.id,
          transport: this.config.transport.type
        });

        // Refresh tool list when the server signals a change. The SDK's
        // protocol already filters notifications by client capability, so the
        // server only sends these if we declared listChanged support.
        try {
          this.client.onNotification?.({ method: 'notifications/tools/list_changed' }, async () => {
            this.toolsCache = null;
            this.appToolsCache = null;
          });
        } catch {
          /* SDK version without this hook — fine, manual refresh still works */
        }
      } catch (err) {
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
    if (this.unhealthy) return [];
    if (this.config.enabled === false) return [];
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

    // A blank prefix means the default: tools of two servers must never share
    // an id, and the admin form leaves the field empty to accept `<id>__`.
    const prefix = this.config.toolPrefix?.trim() || `${this.config.id}__`;
    const allow = this.config.allowedTools || ['*'];
    const allowAll = allow.includes('*');
    const appsEnabled = appsEnabledFor(this.config);

    const tools = [];
    const appTools = new Map();
    for (const t of rawTools) {
      if (!t || typeof t.name !== 'string') continue;
      // Visibility is honoured even with apps disabled: an app-only helper
      // must never reach the model. Only the view link is dropped.
      const meta = readToolUiMeta(t);
      const ui = meta && !appsEnabled ? { ...meta, resourceUri: null } : meta;
      const allowed = allowAll || allow.includes(t.name);

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
        // Internal markers so toolLoader.runTool knows how to dispatch.
        _mcp: {
          serverId: this.config.id,
          originalName: t.name,
          ...(this.config.name ? { serverName: this.config.name } : {}),
          ...(ui?.resourceUri ? { ui: { resourceUri: ui.resourceUri } } : {})
        }
      });
    }
    this.toolsCache = tools;
    this.appToolsCache = appTools;
    return tools;
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
   * @param {string} originalName - The server's own tool name
   * @param {Object} [args]
   * @returns {Promise<Object>} CallToolResult
   */
  async callToolRaw(originalName, args) {
    if (this.unhealthy) {
      throw new Error(`MCP server ${this.config.id} is unhealthy: ${this.lastError}`);
    }
    if (this.config.enabled === false) {
      throw new Error(`MCP server ${this.config.id} is disabled`);
    }
    if (!this.connected) await this.connect();

    const timeoutMs = this.config.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.client.callTool({ name: originalName, arguments: args || {} }, undefined, {
        signal: controller.signal,
        timeout: timeoutMs
      });
    } finally {
      clearTimeout(timer);
    }
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
   */
  async callTool(originalName, args, { onRawResult } = {}) {
    const result = await this.callToolRaw(originalName, args);
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

    return normalizeToolResult(result);
  }

  /**
   * `resources/read` against this server, bounded by the server's timeout.
   * @param {string} uri
   * @returns {Promise<Object>} ReadResourceResult
   */
  async readResource(uri) {
    if (this.unhealthy) {
      throw new Error(`MCP server ${this.config.id} is unhealthy: ${this.lastError}`);
    }
    if (this.config.enabled === false) {
      throw new Error(`MCP server ${this.config.id} is disabled`);
    }
    if (!this.connected) await this.connect();
    const timeoutMs = this.config.timeoutMs ?? 30000;
    return this.client.readResource({ uri }, { timeout: timeoutMs });
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
      toolCount: this.toolsCache ? this.toolsCache.length : null
    };
  }
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

function normalizeToolResult(result) {
  if (!result?.content) return result;
  // Most callers in iHub want a string. If the MCP response is a single text
  // block, surface it as-is; otherwise return the structured array so callers
  // that handle multi-modal output still get everything.
  const parts = result.content;
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text;
  return parts;
}
