import configStore from '../../services/config/ConfigStore.js';
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import {
  a2aAgentsFileSchema,
  a2aAgentConfigSchema
} from '../../validators/a2aAgentConfigSchema.js';
import a2aClientManager from '../../services/a2a/A2aClientManager.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/**
 * Admin API for remote A2A agents (outbound A2A client, #2546):
 * `contents/config/a2aAgents.json`, their health and their skill catalog.
 *
 *   GET    /api/admin/a2a/agents           list, with each agent's status
 *   POST   /api/admin/a2a/agents           create (409 on a duplicate id)
 *   PUT    /api/admin/a2a/agents/:id       update
 *   DELETE /api/admin/a2a/agents/:id       delete
 *   POST   /api/admin/a2a/agents/:id/test  re-fetch a saved agent's card
 *   POST   /api/admin/a2a/test             probe an unsaved agent config
 *   GET    /api/admin/a2a/status           health snapshot
 *   GET    /api/admin/a2a/skills           per-agent skills for the app editor
 *
 * Writes go through ConfigStore and the config cache (never `fs`), then
 * re-initialise the manager on this worker; other workers follow through the
 * `a2aClientManager` config reload hook.
 */

const A2A_FILE = 'config/a2aAgents.json';

const DEFAULT_FILE = { agents: [], security: { blockPrivateIps: true, allowedHosts: [] } };

function readConfig() {
  const { data } = configCache.getA2aAgents();
  return data || DEFAULT_FILE;
}

/**
 * Validate, persist and apply a new a2aAgents.json.
 * @param {Object} updated - The whole file
 * @returns {Promise<Object>} The persisted (parsed) file
 */
async function writeConfig(updated) {
  const parsed = a2aAgentsFileSchema.safeParse(updated);
  if (!parsed.success) {
    const err = new Error('Invalid a2aAgents configuration');
    err.zod = parsed.error.issues;
    throw err;
  }
  // Secrets live in the central credential store (referenced by *Ref fields);
  // the auth block is persisted verbatim.
  await configStore.writeJson(A2A_FILE, parsed.data);
  await configCache.refreshCacheEntry?.(A2A_FILE);
  await a2aClientManager.initialize(configCache.getA2aAgents().data);
  return parsed.data;
}

function invalid(res, parsed) {
  return res.status(400).json({
    success: false,
    error: 'Invalid agent config',
    details: parsed.error.issues
  });
}

/**
 * Register the admin A2A agent routes.
 * @param {import('express').Application} app
 */
export default function registerAdminA2aAgentsRoutes(app) {
  app.get(buildServerPath('/api/admin/a2a/agents'), adminAuth, (req, res) => {
    try {
      const cfg = readConfig();
      const statuses = new Map(a2aClientManager.status().map(s => [s.id, s]));
      res.json({
        success: true,
        agents: (cfg.agents || []).map(agent => ({
          ...agent,
          status: statuses.get(agent.id) || null
        })),
        security: cfg.security
      });
    } catch (error) {
      logger.error('[A2A Admin] List error', { component: 'AdminA2a', error });
      res.status(500).json({ success: false, error: 'Failed to list A2A agents' });
    }
  });

  app.post(buildServerPath('/api/admin/a2a/agents'), adminAuth, async (req, res) => {
    try {
      const parsed = a2aAgentConfigSchema.safeParse(req.body);
      if (!parsed.success) return invalid(res, parsed);
      const cfg = readConfig();
      if ((cfg.agents || []).some(agent => agent.id === parsed.data.id)) {
        return res.status(409).json({ success: false, error: 'Agent id already exists' });
      }
      await writeConfig({ ...cfg, agents: [...(cfg.agents || []), parsed.data] });
      res.status(201).json({ success: true, agent: parsed.data });
    } catch (error) {
      logger.error('[A2A Admin] Create error', { component: 'AdminA2a', error });
      res.status(500).json({ success: false, error: error.message || 'Failed to create agent' });
    }
  });

  app.put(buildServerPath('/api/admin/a2a/agents/:id'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'a2aAgent', res)) return;
      const parsed = a2aAgentConfigSchema.safeParse({ ...req.body, id });
      if (!parsed.success) return invalid(res, parsed);
      const cfg = readConfig();
      const idx = (cfg.agents || []).findIndex(agent => agent.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }
      await writeConfig({
        ...cfg,
        agents: cfg.agents.map((agent, i) => (i === idx ? parsed.data : agent))
      });
      res.json({ success: true, agent: parsed.data });
    } catch (error) {
      logger.error('[A2A Admin] Update error', { component: 'AdminA2a', error });
      res.status(500).json({ success: false, error: error.message || 'Failed to update agent' });
    }
  });

  app.delete(buildServerPath('/api/admin/a2a/agents/:id'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'a2aAgent', res)) return;
      const cfg = readConfig();
      if (!(cfg.agents || []).some(agent => agent.id === id)) {
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }
      await writeConfig({ ...cfg, agents: cfg.agents.filter(agent => agent.id !== id) });
      res.status(204).end();
    } catch (error) {
      logger.error('[A2A Admin] Delete error', { component: 'AdminA2a', error });
      res.status(500).json({ success: false, error: error.message || 'Failed to delete agent' });
    }
  });

  // Re-fetch a saved agent's card and list its skills.
  app.post(buildServerPath('/api/admin/a2a/agents/:id/test'), adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validateIdForPath(id, 'a2aAgent', res)) return;
      const { status, card, skills } = await a2aClientManager.testConnection(id);
      res.json({ success: true, status, card, skills });
    } catch (error) {
      logger.warn('[A2A Admin] Test connection failed', {
        component: 'AdminA2a',
        error: error.message
      });
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Probe an unsaved agent config: fetch its card and preview every skill.
  app.post(buildServerPath('/api/admin/a2a/test'), adminAuth, async (req, res) => {
    try {
      const { status, card, skills } = await a2aClientManager.testConfig({ ...req.body });
      res.json({ success: true, status, card, skills });
    } catch (error) {
      logger.warn('[A2A Admin] Test config failed', {
        component: 'AdminA2a',
        error: error.message
      });
      res.status(400).json({ success: false, error: error.message, details: error.details });
    }
  });

  app.get(buildServerPath('/api/admin/a2a/status'), adminAuth, (req, res) => {
    res.json({ success: true, agents: a2aClientManager.status() });
  });

  // Per-agent skill catalog for the app editor's picker. Best-effort: an agent
  // whose card cannot be fetched is listed with an `error`.
  app.get(buildServerPath('/api/admin/a2a/skills'), adminAuth, async (req, res) => {
    try {
      res.json({ success: true, agents: await a2aClientManager.listSkillsByAgent() });
    } catch (error) {
      logger.error('[A2A Admin] Skill catalog error', { component: 'AdminA2a', error });
      res.status(500).json({ success: false, error: 'Failed to list A2A agent skills' });
    }
  });
}
