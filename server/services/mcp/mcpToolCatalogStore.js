/**
 * Tool catalog of `oauthUser` MCP servers.
 *
 * The catalog holds the server's raw `tools/list` entries; the manager builds
 * the iHub tool definitions from them with the server's current prefix and
 * allowlist, so editing those settings needs no new listing. A catalog listed
 * from another endpoint (`endpoint` differs from the configured URL) is
 * ignored.
 *
 * `tools/list` on a per-user server needs a user's token, so the catalog the
 * chat, the app editor and the gateway read cannot come from a shared
 * connection. iHub keeps ONE catalog per server: the tool list of the most
 * recent successful `tools/list` of any user's connection. It is held in
 * memory by the manager and persisted as a document in the `mcp-tool-catalog`
 * namespace, keyed by server id, so it survives restarts and is shared by
 * every worker. Without a storage provider the catalog is memory-only.
 *
 * @module services/mcp/mcpToolCatalogStore
 */
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpToolCatalogStore';

export const MCP_TOOL_CATALOG_NAMESPACE = RUNTIME_NAMESPACES.mcpToolCatalog;

export class McpToolCatalogStore {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   * @param {() => number} [options.now]
   */
  constructor({ documents, now = () => Date.now() } = {}) {
    this._documents = documents;
    this._pinned = documents !== undefined;
    this.now = now;
    /** @type {Map<string, {serverId: string, tools: Object[], updatedAt: string}>} */
    this.memory = new Map();
  }

  _docs() {
    if (this._pinned) return this._documents || null;
    return readFacet(getStorage(), 'documents');
  }

  /**
   * The stored catalog of a server, or null when no user has listed its tools yet.
   * @param {string} serverId
   * @returns {Promise<{serverId: string, tools: Object[], updatedAt: string}|null>}
   */
  async get(serverId) {
    if (typeof serverId !== 'string' || !serverId) return null;
    const documents = this._docs();
    if (documents) {
      try {
        const doc = await documents.get(MCP_TOOL_CATALOG_NAMESPACE, serverId);
        if (Array.isArray(doc?.data?.tools)) {
          this.memory.set(serverId, doc.data);
          return doc.data;
        }
        this.memory.delete(serverId);
        return null;
      } catch (error) {
        logger.warn('MCP tool catalog read failed; using in-memory copy', {
          component: COMPONENT,
          serverId,
          error: error.message
        });
      }
    }
    return this.memory.get(serverId) || null;
  }

  /**
   * Replace a server's catalog.
   * @param {string} serverId
   * @param {Object[]} tools - The server's own `tools/list` entries (raw, unprefixed)
   * @param {Object} [options]
   * @param {string} [options.endpoint] - Transport URL the list came from
   * @returns {Promise<{serverId: string, tools: Object[], endpoint: (string|null), updatedAt: string}>}
   */
  async put(serverId, tools, { endpoint = null } = {}) {
    const record = {
      serverId,
      tools: Array.isArray(tools) ? tools : [],
      endpoint,
      updatedAt: new Date(this.now()).toISOString()
    };
    this.memory.set(serverId, record);
    const documents = this._docs();
    if (documents) {
      try {
        await documents.put(MCP_TOOL_CATALOG_NAMESPACE, serverId, record, { ownerId: 'system' });
      } catch (error) {
        logger.warn('MCP tool catalog write failed; kept on this worker only', {
          component: COMPONENT,
          serverId,
          error: error.message
        });
      }
    }
    return record;
  }

  /**
   * Drop a server's catalog (server removed or reconfigured).
   * @param {string} serverId
   * @returns {Promise<void>}
   */
  async clear(serverId) {
    this.memory.delete(serverId);
    const documents = this._docs();
    if (!documents) return;
    try {
      await documents.delete(MCP_TOOL_CATALOG_NAMESPACE, serverId);
    } catch (error) {
      logger.warn('MCP tool catalog delete failed', {
        component: COMPONENT,
        serverId,
        error: error.message
      });
    }
  }
}

let singleton = null;

/**
 * The process-wide store.
 * @returns {McpToolCatalogStore}
 */
export function getMcpToolCatalogStore() {
  if (!singleton) singleton = new McpToolCatalogStore();
  return singleton;
}

/** Test seam: replace the singleton. */
export function setMcpToolCatalogStoreForTests(store) {
  singleton = store;
}
