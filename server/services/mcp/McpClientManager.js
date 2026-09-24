import { McpServerConnection } from './McpServerConnection.js';
import {
  mcpServersFileSchema,
  mcpServerConfigSchema
} from '../../validators/mcpServerConfigSchema.js';
import logger from '../../utils/logger.js';

/**
 * Keys iHub adds to every tool call's params for its own tools (the chat's
 * identity, the acting user, the app config, workflow plumbing). They are
 * never the model's arguments and must not leave iHub: an external MCP server
 * would otherwise receive the full user object and app configuration.
 */
const IHUB_CONTEXT_KEYS = new Set(['chatId', 'user', 'appConfig', 'passthrough', '_fileData']);

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
    parameters: t.parameters || { type: 'object', properties: {} }
  }));
}

/**
 * Singleton that owns one McpServerConnection per configured MCP server.
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
    this.security = { blockPrivateIps: true, allowedHosts: [] };
    this.initialized = false;
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

    // Remove connections that no longer exist or whose transport (or the
    // capabilities negotiated at connect) changed.
    for (const [id, conn] of this.connections) {
      const next = wanted.get(id);
      if (!next || connectionChanged(conn.config, next)) {
        await conn.disconnect();
        this.connections.delete(id);
      }
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
        continue;
      }
      this.connections.set(id, new McpServerConnection(cfg, this.security));
    }

    this.initialized = true;
    logger.info('McpClientManager initialised', {
      component: 'McpClientManager',
      serverCount: this.connections.size
    });
  }

  async shutdown() {
    await Promise.all(
      Array.from(this.connections.values()).map(c => c.disconnect().catch(() => {}))
    );
    this.connections.clear();
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
          const tools = await conn.listTools();
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
        tools = await conn.listTools();
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
   * before the call leaves iHub — see `toMcpArguments`.
   *
   * @param {string} prefixedName - iHub tool id
   * @param {Object} params - Params as handed to `runTool`
   * @param {Object} [options]
   * @param {Function} [options.onRawResult] - Receives the raw CallToolResult
   *   of a tool that renders an MCP App view
   */
  async callTool(prefixedName, params, { onRawResult } = {}) {
    const found = await this.findTool(prefixedName);
    if (!found) throw new Error(`MCP tool not found: ${prefixedName}`);
    const { conn, tool } = found;
    return conn.callTool(tool._mcp.originalName, toMcpArguments(params, tool.parameters), {
      ...(tool._mcp.ui?.resourceUri && typeof onRawResult === 'function' ? { onRawResult } : {})
    });
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
    return Array.from(this.connections.values()).map(c => c.status());
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
          enabled: conn.config.enabled !== false,
          tools: [],
          error: null
        };
        if (entry.enabled) {
          try {
            entry.tools = summarizeTools(await conn.listTools());
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
  async testConnection(serverId) {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`MCP server not found: ${serverId}`);
    await conn.disconnect();
    conn.consecutiveFailures = 0;
    conn.unhealthy = false;
    await conn.connect();
    const tools = await conn.listTools(); // also exercise tools/list
    return { status: conn.status(), tools: summarizeTools(tools) };
  }

  /**
   * Probe an arbitrary (possibly unsaved) server config without registering
   * it. Used by the admin dialog so an operator can validate a connection and
   * preview the available tools before persisting the server. The ephemeral
   * connection is always torn down, even on failure, so no socket or child
   * process leaks.
   */
  async testConfig(rawServerConfig) {
    const parsed = mcpServerConfigSchema.safeParse(rawServerConfig);
    if (!parsed.success) {
      const err = new Error('Invalid server config');
      err.details = parsed.error.issues;
      throw err;
    }
    // Force-enable for the probe: the admin explicitly asked to test it, even
    // if they intend to leave the server disabled after saving.
    const conn = new McpServerConnection({ ...parsed.data, enabled: true }, this.security);
    try {
      await conn.connect();
      const tools = await conn.listTools();
      return { status: conn.status(), tools: summarizeTools(tools) };
    } finally {
      await conn.disconnect().catch(() => {});
    }
  }
}

function connectionChanged(a, b) {
  return (
    JSON.stringify(a.transport) !== JSON.stringify(b.transport) ||
    (a.apps?.enabled !== false) !== (b.apps?.enabled !== false)
  );
}

const instance = new McpClientManager();
export default instance;
