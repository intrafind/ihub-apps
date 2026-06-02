import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { URL } from 'url';
import tokenStorageService from '../TokenStorageService.js';
import { safeFetch, assertSafeHost } from './safeFetch.js';
import logger from '../../utils/logger.js';

/**
 * One MCPServerConnection wraps the SDK `Client` for a single configured
 * MCP server. It owns:
 *   - transport construction (streamableHttp, sse, stdio, websocket)
 *   - lazy connect on first use
 *   - exponential-backoff auto-reconnect
 *   - tool catalog cache (refreshed on `tools/list_changed`)
 *   - hard timeout + cancellation around `tools/call`
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
    this.toolsCache = null; // last result of tools/list
    this.consecutiveFailures = 0;
    // Marked unhealthy after `maxRetries` consecutive failures. The manager
    // skips unhealthy connections in `listAllTools` so a broken server doesn't
    // poison aggregate tool discovery.
    this.unhealthy = false;
  }

  /**
   * Decrypt secrets pulled from auth config. configCache already decrypts
   * platform secrets, but mcpServers.json has its own encryption envelope.
   */
  _decryptAuth(auth) {
    if (!auth) return { type: 'none' };
    const out = { ...auth };
    for (const key of ['token', 'password', 'clientSecret']) {
      if (typeof out[key] === 'string' && tokenStorageService.isEncrypted(out[key])) {
        try {
          out[key] = tokenStorageService.decryptString(out[key]);
        } catch (err) {
          logger.error('Failed to decrypt MCP server auth secret', {
            component: 'McpServerConnection',
            serverId: this.config.id,
            field: key,
            error: err.message
          });
        }
      }
    }
    return out;
  }

  /**
   * Build static auth headers for bearer/basic. OAuth is handled separately
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
    const auth = this._decryptAuth(this.config.auth);

    const blockPrivateIps = this.security.blockPrivateIps !== false;

    if (t.type === 'streamableHttp' || t.type === 'sse') {
      const url = new URL(t.url);
      // SSRF guard up-front. The transport will re-resolve later but our
      // pinned-IP fetch (safeFetch) refuses the connect if the resolved
      // address has shifted to a private range.
      await assertSafeHost(url.hostname, this.security.allowedHosts, blockPrivateIps);

      const requestInit = { headers: this._buildAuthHeaders(auth) };
      const allowHosts = this.security.allowedHosts;

      // Use our DNS-pinned fetch as the SDK's underlying transport so the
      // socket can't be steered to a private IP between validation and connect.
      // Auth headers are resolved per request so OAuth client-credentials
      // tokens refresh transparently without rebuilding the transport.
      const pinnedFetch = async (input, init = {}) => {
        const authHeaders = await this._getAuthHeaders(auth);
        return safeFetch(
          input,
          { ...init, headers: { ...(init.headers || {}), ...authHeaders } },
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
        this.client = new Client({ name: 'ihub-apps', version: '1.0.0' }, { capabilities: {} });
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
  }

  /**
   * List tools advertised by this server, applying the allowlist filter.
   * Returns the raw `Tool` objects from the MCP spec, augmented with iHub's
   * prefix metadata so the caller can map back to this server in `runTool`.
   */
  async listTools() {
    if (this.unhealthy) return [];
    if (this.config.enabled === false) return [];
    if (!this.connected) await this.connect();
    if (this.toolsCache) return this.toolsCache;

    const result = await this.client.listTools({});
    const prefix = this.config.toolPrefix ?? `${this.config.id}__`;
    const allow = this.config.allowedTools || ['*'];
    const allowAll = allow.includes('*');

    const tools = (result.tools || [])
      .filter(t => allowAll || allow.includes(t.name))
      .map(t => ({
        // iHub-facing id; runMcpTool splits on the prefix delimiter.
        id: `${prefix}${t.name}`,
        name: `${prefix}${t.name}`,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
        // Internal markers so toolLoader.runTool knows how to dispatch.
        _mcp: {
          serverId: this.config.id,
          originalName: t.name
        }
      }));
    this.toolsCache = tools;
    return tools;
  }

  /**
   * Invoke a tool. Wraps the SDK call in a hard timeout and translates the
   * MCP-spec `isError: true` success response into a thrown Error — without
   * this, every tool-level failure surfaces as a successful response with
   * garbage content in the model context (issue #1460 comment, gap #3).
   */
  async callTool(originalName, args) {
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
      const result = await this.client.callTool(
        { name: originalName, arguments: args || {} },
        undefined,
        { signal: controller.signal, timeout: timeoutMs }
      );

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
    } finally {
      clearTimeout(timer);
    }
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
