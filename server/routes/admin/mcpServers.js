import configStore from '../../services/config/ConfigStore.js';
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import {
  mcpServersFileSchema,
  mcpServerConfigSchema
} from '../../validators/mcpServerConfigSchema.js';
import mcpClientManager from '../../services/mcp/McpClientManager.js';
import { MCP_SERVER_CATALOG, MCP_CATALOG_CATEGORIES } from '../../services/mcp/serverCatalog.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { listServerConnections } from '../../services/mcp/mcpUserTokens.js';
import { isUserOAuthServer, revokeUserConnection } from '../../services/mcp/mcpOAuthService.js';

const MCP_FILE = 'config/mcpServers.json';

async function readConfig() {
  const { data } = configCache.getMcpServers();
  return data || { servers: [], security: { blockPrivateIps: true, allowedHosts: [] } };
}

async function writeConfig(updated) {
  const parsed = mcpServersFileSchema.safeParse(updated);
  if (!parsed.success) {
    const err = new Error('Invalid mcpServers configuration');
    err.zod = parsed.error.issues;
    throw err;
  }
  // Secrets live in the central credential store (referenced by *Ref fields);
  // the auth block is persisted verbatim.
  await configStore.writeJson(MCP_FILE, parsed.data);
  // Refresh in-memory cache + reload manager.
  await configCache.refreshCacheEntry?.(MCP_FILE);
  const { data: fresh } = configCache.getMcpServers();
  await mcpClientManager.initialize(fresh);
  return parsed.data;
}

// Endpoint identity for matching catalog entries against configured servers:
// case-insensitive, ignoring a trailing slash.
function endpointKey(transport) {
  return typeof transport?.url === 'string'
    ? transport.url.trim().replace(/\/+$/, '').toLowerCase()
    : null;
}

export default function registerAdminMcpServersRoutes(app) {
  // List all configured outbound MCP servers. Secrets live in the central
  // credential store; the auth block here only carries credentialRef pointers.
  app.get(buildServerPath('/api/admin/mcp/servers'), adminAuth, async (req, res) => {
    try {
      const cfg = await readConfig();
      const statuses = new Map(mcpClientManager.status().map(s => [s.id, s]));
      const servers = await Promise.all(
        (cfg.servers || []).map(async s => ({
          ...s,
          status: statuses.get(s.id) || null,
          // Per-user OAuth: how many users have connected their account.
          ...(isUserOAuthServer(s)
            ? {
                connectedUsers: (await listServerConnections(s.id, s).catch(() => [])).length
              }
            : {})
        }))
      );
      res.json({ success: true, servers, security: cfg.security });
    } catch (error) {
      logger.error('[MCP Admin] List error', { component: 'AdminMcp', error });
      res.status(500).json({ success: false, error: 'Failed to list MCP servers' });
    }
  });

  // Create a new outbound MCP server.
  app.post(buildServerPath('/api/admin/mcp/servers'), adminAuth, async (req, res) => {
    try {
      const parsed = mcpServerConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid server config',
          details: parsed.error.issues
        });
      }
      const cfg = await readConfig();
      if ((cfg.servers || []).some(s => s.id === parsed.data.id)) {
        return res.status(409).json({ success: false, error: 'Server id already exists' });
      }
      // Apps and groups reference MCP servers and remote A2A agents by the
      // same bare id; a shared id would enable both at once.
      const a2aAgents = configCache.getA2aAgents?.()?.data?.agents || [];
      const clash = a2aAgents.find(
        agent => String(agent?.id).toLowerCase() === parsed.data.id.toLowerCase()
      );
      if (clash) {
        return res.status(409).json({
          success: false,
          error: `Server id "${parsed.data.id}" is already used by the A2A agent "${clash.id}". Apps and groups reference servers and agents by id, so the server needs an id of its own.`
        });
      }
      const updated = { ...cfg, servers: [...(cfg.servers || []), parsed.data] };
      await writeConfig(updated);
      res.status(201).json({ success: true, server: parsed.data });
    } catch (error) {
      logger.error('[MCP Admin] Create error', { component: 'AdminMcp', error });
      res.status(500).json({ success: false, error: error.message || 'Failed to create server' });
    }
  });

  // Update an existing server.
  app.put(buildServerPath('/api/admin/mcp/servers/:id'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'mcpServer', res)) return;
      const parsed = mcpServerConfigSchema.safeParse({ ...req.body, id });
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid server config',
          details: parsed.error.issues
        });
      }
      const cfg = await readConfig();
      const idx = (cfg.servers || []).findIndex(s => s.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Server not found' });
      }
      // Secrets are referenced by *Ref pointers into the credential store, so
      // the incoming auth block is persisted as-is.
      const incoming = parsed.data;
      const updated = {
        ...cfg,
        servers: cfg.servers.map((s, i) => (i === idx ? incoming : s))
      };
      await writeConfig(updated);
      res.json({ success: true, server: incoming });
    } catch (error) {
      logger.error('[MCP Admin] Update error', { component: 'AdminMcp', error });
      res.status(500).json({ success: false, error: error.message || 'Failed to update server' });
    }
  });

  // Delete a server.
  app.delete(buildServerPath('/api/admin/mcp/servers/:id'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'mcpServer', res)) return;
      const cfg = await readConfig();
      if (!(cfg.servers || []).some(s => s.id === id)) {
        return res.status(404).json({ success: false, error: 'Server not found' });
      }
      const updated = { ...cfg, servers: cfg.servers.filter(s => s.id !== id) };
      await writeConfig(updated);
      res.status(204).end();
    } catch (error) {
      logger.error('[MCP Admin] Delete error', { component: 'AdminMcp', error });
      res.status(500).json({ success: false, error: error.message || 'Failed to delete server' });
    }
  });

  // Probe a saved server connection and refresh its tool catalog.
  app.post(buildServerPath('/api/admin/mcp/servers/:id/test'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'mcpServer', res)) return;
      // Per-user OAuth servers are tested with the acting admin's own token;
      // without one the result is `status: 'auth_required'` plus a connectUrl.
      const result = await mcpClientManager.testConnection(id, req.user);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.warn('[MCP Admin] Test connection failed', {
        component: 'AdminMcp',
        error: error.message
      });
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Probe an arbitrary (possibly unsaved) server config. Used by the create /
  // edit dialog so the admin can validate a connection and preview the tools
  // before persisting. Auth secrets are referenced by *Ref pointers into the
  // central credential store and resolved at connect time, so the incoming
  // config is tested as submitted.
  app.post(buildServerPath('/api/admin/mcp/test'), adminAuth, async (req, res) => {
    try {
      const incoming = { ...req.body };
      const result = await mcpClientManager.testConfig(incoming, req.user);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.warn('[MCP Admin] Test config failed', {
        component: 'AdminMcp',
        error: error.message
      });
      res.status(400).json({ success: false, error: error.message, details: error.details });
    }
  });

  // Users who connected their own account to a per-user OAuth server.
  app.get(
    buildServerPath('/api/admin/mcp/servers/:id/connections'),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        if (!validateIdForPath(id, 'mcpServer', res)) return;
        const cfg = await readConfig();
        const server = (cfg.servers || []).find(s => s.id === id);
        if (!server) return res.status(404).json({ success: false, error: 'Server not found' });
        if (!isUserOAuthServer(server)) {
          return res.json({ success: true, connections: [] });
        }
        const connections = await listServerConnections(id, server);
        res.json({
          success: true,
          connections: connections.map(({ storageId: _storageId, ...c }) => c)
        });
      } catch (error) {
        logger.error('[MCP Admin] List user connections error', { component: 'AdminMcp', error });
        res.status(500).json({ success: false, error: 'Failed to list connections' });
      }
    }
  );

  // Forget iHub's OAuth client registration at a per-user server's
  // authorization server (CIMD / DCR), so the next sign-in registers afresh.
  // The recovery path when the authorization server no longer knows the
  // client (it then refuses the sign-in on its own page, which never comes
  // back to iHub). Users' tokens stay; a refresh with the old client fails
  // and asks them to connect again.
  app.post(
    buildServerPath('/api/admin/mcp/servers/:id/registration/reset'),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        if (!validateIdForPath(id, 'mcpServer', res)) return;
        const conn = mcpClientManager.getConnection(id);
        if (!conn || !isUserOAuthServer(conn.config)) {
          return res.status(404).json({ success: false, error: 'Server not found' });
        }
        await mcpClientManager.resetClientRegistration(id);
        logger.info('[MCP Admin] OAuth client registration reset', {
          component: 'AdminMcp',
          serverId: id,
          adminId: req.user?.id
        });
        res.json({ success: true });
      } catch (error) {
        logger.error('[MCP Admin] Reset registration error', { component: 'AdminMcp', error });
        res.status(500).json({ success: false, error: 'Failed to reset the registration' });
      }
    }
  );

  // Disconnect one user from a per-user OAuth server: revoke at the
  // authorization server when possible, delete the stored tokens.
  app.delete(
    buildServerPath('/api/admin/mcp/servers/:id/connections/:userId'),
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        if (!validateIdForPath(id, 'mcpServer', res)) return;
        // A store key, never a path: the token store maps ids outside its
        // file-name allowlist to a hashed storage id itself.
        const userId = String(req.params.userId || '');
        if (!userId || userId.length > 256) {
          return res.status(400).json({ success: false, error: 'Invalid userId' });
        }
        const conn = mcpClientManager.getConnection(id);
        if (!conn || !isUserOAuthServer(conn.config)) {
          return res.status(404).json({ success: false, error: 'Server not found' });
        }
        const result = await revokeUserConnection({
          serverConfig: conn.config,
          userId,
          security: mcpClientManager.security,
          clientStore: mcpClientManager.clientRegistrations()
        });
        await mcpClientManager.evictUserConnection(id, userId);
        if (!result.removed) {
          return res.status(404).json({ success: false, error: 'Connection not found' });
        }
        logger.info('[MCP Admin] User disconnected from MCP server', {
          component: 'AdminMcp',
          serverId: id,
          userId,
          adminId: req.user?.id
        });
        res.json({ success: true, ...result });
      } catch (error) {
        logger.error('[MCP Admin] Disconnect user error', { component: 'AdminMcp', error });
        res.status(500).json({ success: false, error: 'Failed to disconnect user' });
      }
    }
  );

  // Built-in catalog of hosted MCP servers the admin can start from. An entry
  // is `installed` when a configured server already uses its id or endpoint.
  app.get(buildServerPath('/api/admin/mcp/catalog'), adminAuth, async (req, res) => {
    try {
      const cfg = await readConfig();
      const servers = cfg.servers || [];
      const ids = new Set(servers.map(s => s.id));
      const endpoints = new Set(servers.map(s => endpointKey(s.transport)).filter(Boolean));
      res.json({
        success: true,
        categories: MCP_CATALOG_CATEGORIES,
        entries: MCP_SERVER_CATALOG.map(entry => ({
          ...entry,
          installed: ids.has(entry.id) || endpoints.has(endpointKey(entry.transport))
        }))
      });
    } catch (error) {
      logger.error('[MCP Admin] Catalog error', { component: 'AdminMcp', error });
      res.status(500).json({ success: false, error: 'Failed to load MCP server catalog' });
    }
  });

  // Aggregate health snapshot.
  app.get(buildServerPath('/api/admin/mcp/status'), adminAuth, (req, res) => {
    res.json({ success: true, servers: mcpClientManager.status() });
  });

  // Per-server tool catalog for the app editor's MCP picker. Best-effort: each
  // server reports its discovered tools, or an `error` if discovery failed.
  app.get(buildServerPath('/api/admin/mcp/tools'), adminAuth, async (req, res) => {
    try {
      const servers = await mcpClientManager.listToolsByServer();
      res.json({ success: true, servers });
    } catch (error) {
      logger.error('[MCP Admin] Tool catalog error', { component: 'AdminMcp', error });
      res.status(500).json({ success: false, error: 'Failed to list MCP tools' });
    }
  });

  // ---- Inbound gateway settings ----
  // (Light wrapper that reads/writes platform.mcpServer. We don't write the
  // whole platform.json here — the existing admin/configs.js platform write
  // path handles that. This route just returns the current gateway block for
  // the UI to render alongside the OAuth client list.)
  app.get(buildServerPath('/api/admin/mcp/gateway'), adminAuth, (req, res) => {
    const platform = configCache.getPlatform() || {};
    res.json({ success: true, gateway: platform.mcpServer || { enabled: false } });
  });
}
