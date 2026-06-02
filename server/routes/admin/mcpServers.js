import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import {
  mcpServersFileSchema,
  mcpServerConfigSchema
} from '../../validators/mcpServerConfigSchema.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import mcpClientManager from '../../services/mcp/McpClientManager.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_FILE_PATH = path.join(__dirname, '../../../contents/config/mcpServers.json');

function encryptSecrets(server) {
  const out = { ...server };
  if (out.auth) out.auth = { ...out.auth };
  if (out.auth && typeof out.auth === 'object') {
    for (const field of ['token', 'password', 'clientSecret']) {
      const v = out.auth[field];
      if (typeof v !== 'string' || !v) continue;
      if (tokenStorageService.isEncrypted(v)) continue;
      if (/^\$\{[^}]+\}$/.test(v)) continue; // env-var placeholder
      try {
        out.auth[field] = tokenStorageService.encryptString(v);
      } catch (err) {
        logger.warn('Could not encrypt MCP secret', {
          component: 'AdminMcp',
          field,
          error: err.message
        });
      }
    }
  }
  return out;
}

function redactSecrets(server) {
  const out = JSON.parse(JSON.stringify(server));
  if (out.auth && typeof out.auth === 'object') {
    for (const field of ['token', 'password', 'clientSecret']) {
      if (out.auth[field]) out.auth[field] = '***REDACTED***';
    }
  }
  return out;
}

async function readConfig() {
  const { data } = configCache.getMcpServers();
  return data || { servers: [], security: { blockPrivateIps: true, allowedHosts: [] } };
}

async function writeConfig(updated) {
  const parsed = mcpServersFileSchema.safeParse(updated);
  if (!parsed.success) {
    const err = new Error('Invalid mcpServers configuration');
    err.zod = parsed.error.errors;
    throw err;
  }
  // Encrypt secrets on write.
  const encrypted = {
    ...parsed.data,
    servers: parsed.data.servers.map(encryptSecrets)
  };
  await atomicWriteJSON(MCP_FILE_PATH, encrypted);
  // Refresh in-memory cache + reload manager.
  await configCache.refreshCacheEntry?.('config/mcpServers.json');
  const { data: fresh } = configCache.getMcpServers();
  await mcpClientManager.initialize(fresh);
  return parsed.data;
}

export default function registerAdminMcpServersRoutes(app) {
  // List all configured outbound MCP servers (secrets redacted).
  app.get(buildServerPath('/api/admin/mcp/servers'), adminAuth, async (req, res) => {
    try {
      const cfg = await readConfig();
      const statuses = new Map(mcpClientManager.status().map(s => [s.id, s]));
      res.json({
        success: true,
        servers: (cfg.servers || []).map(s => ({
          ...redactSecrets(s),
          status: statuses.get(s.id) || null
        })),
        security: cfg.security
      });
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
          details: parsed.error.errors
        });
      }
      const cfg = await readConfig();
      if ((cfg.servers || []).some(s => s.id === parsed.data.id)) {
        return res.status(409).json({ success: false, error: 'Server id already exists' });
      }
      const updated = { ...cfg, servers: [...(cfg.servers || []), parsed.data] };
      await writeConfig(updated);
      res.status(201).json({ success: true, server: redactSecrets(parsed.data) });
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
          details: parsed.error.errors
        });
      }
      const cfg = await readConfig();
      const idx = (cfg.servers || []).findIndex(s => s.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Server not found' });
      }
      // Preserve existing encrypted secrets when the admin submits the redacted placeholder.
      const existing = cfg.servers[idx];
      const incoming = parsed.data;
      if (incoming.auth && existing.auth) {
        for (const f of ['token', 'password', 'clientSecret']) {
          if (incoming.auth[f] === '***REDACTED***' && existing.auth[f]) {
            incoming.auth[f] = existing.auth[f];
          }
        }
      }
      const updated = {
        ...cfg,
        servers: cfg.servers.map((s, i) => (i === idx ? incoming : s))
      };
      await writeConfig(updated);
      res.json({ success: true, server: redactSecrets(incoming) });
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
      const { status, tools } = await mcpClientManager.testConnection(id);
      res.json({ success: true, status, tools });
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
  // before persisting. Redacted secrets submitted for an existing server are
  // restored from the stored (encrypted) config so editing without retyping a
  // token still tests correctly.
  app.post(buildServerPath('/api/admin/mcp/test'), adminAuth, async (req, res) => {
    try {
      const incoming = { ...req.body };
      const cfg = await readConfig();
      const existing = (cfg.servers || []).find(s => s.id === incoming.id);
      if (incoming.auth && existing?.auth) {
        incoming.auth = { ...incoming.auth };
        for (const f of ['token', 'password', 'clientSecret']) {
          if (incoming.auth[f] === '***REDACTED***' && existing.auth[f]) {
            incoming.auth[f] = existing.auth[f];
          }
        }
      }
      const { status, tools } = await mcpClientManager.testConfig(incoming);
      res.json({ success: true, status, tools });
    } catch (error) {
      logger.warn('[MCP Admin] Test config failed', {
        component: 'AdminMcp',
        error: error.message
      });
      res.status(400).json({ success: false, error: error.message, details: error.details });
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
