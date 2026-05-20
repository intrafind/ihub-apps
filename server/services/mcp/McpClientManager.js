import { McpServerConnection } from './McpServerConnection.js';
import { mcpServersFileSchema } from '../../validators/mcpServerConfigSchema.js';
import logger from '../../utils/logger.js';

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
        errors: parsed.error.errors
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

    // Remove connections that no longer exist or whose transport changed.
    for (const [id, conn] of this.connections) {
      const next = wanted.get(id);
      if (!next || transportChanged(conn.config, next)) {
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
   * Resolve a prefixed tool id back to its owning server and call it.
   * Throws if no connection produces a matching tool.
   */
  async callTool(prefixedName, args) {
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
      if (tool) {
        return conn.callTool(tool._mcp.originalName, args);
      }
    }
    throw new Error(`MCP tool not found: ${prefixedName}`);
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
   * Force-trigger a connection attempt and return its status. Used by the
   * admin "Test connection" button.
   */
  async testConnection(serverId) {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`MCP server not found: ${serverId}`);
    await conn.disconnect();
    conn.consecutiveFailures = 0;
    conn.unhealthy = false;
    await conn.connect();
    await conn.listTools(); // also exercise tools/list
    return conn.status();
  }
}

function transportChanged(a, b) {
  return JSON.stringify(a.transport) !== JSON.stringify(b.transport);
}

const instance = new McpClientManager();
export default instance;
