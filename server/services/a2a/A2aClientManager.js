import { A2aAgentConnection } from './A2aAgentConnection.js';
import {
  a2aAgentsFileSchema,
  a2aAgentConfigSchema
} from '../../validators/a2aAgentConfigSchema.js';
import { emitToolProgress } from '../loop/RunStream.js';
import { getLocalizedString } from '../../utils/localize.js';
import logger from '../../utils/logger.js';

/** Most (user, chat, agent) → contextId entries remembered at once. */
export const MAX_REMEMBERED_CONTEXTS = 5000;

const DEFAULT_SECURITY = { blockPrivateIps: true, allowedHosts: [] };

/** `tool/progress` phase the chat receives while a remote agent works. */
const PROGRESS_PHASE = 'a2a.status';

/**
 * Slim down a card skill for the admin UI and the app editor's picker.
 */
function summarizeSkill(skill, toolId) {
  return {
    id: skill.id,
    name: typeof skill.name === 'string' && skill.name ? skill.name : skill.id,
    description: typeof skill.description === 'string' ? skill.description : '',
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    ...(Array.isArray(skill.examples) && skill.examples.length ? { examples: skill.examples } : {}),
    ...(toolId ? { toolId } : {})
  };
}

/** The card as the admin page shows it. */
function summarizeCard(card) {
  return {
    name: card.name,
    description: card.description || '',
    version: card.version || '',
    protocolVersion: card.protocolVersion,
    url: card.url,
    streaming: card.capabilities?.streaming === true
  };
}

/**
 * Singleton that owns one A2aAgentConnection per configured remote agent.
 *
 * Lifecycle mirrors McpClientManager:
 *   1. `initialize(config)` validates `a2aAgents.json`, builds connections
 *      (the card is fetched lazily on first use) and keeps the parsed config.
 *   2. A later `initialize` diffs: agents that disappeared or whose card URL
 *      or auth changed get a fresh connection; the others keep theirs.
 *   3. `listAllTools()` aggregates the skills of every enabled agent as tools.
 *   4. `callTool(toolId, params)` finds the owning agent, sends the message,
 *      and remembers the conversation (`contextId`) per user, chat and agent.
 */
class A2aClientManager {
  constructor() {
    this.connections = new Map(); // agentId -> A2aAgentConnection
    this.security = { ...DEFAULT_SECURITY };
    this.initialized = false;
    // `${userId}\u0000${chatId}\u0000${agentId}` -> contextId, LRU-ordered
    this.contexts = new Map();
  }

  /**
   * (Re)load the manager from a raw a2aAgents.json object.
   * @param {Object} rawConfig
   */
  async initialize(rawConfig) {
    const parsed = a2aAgentsFileSchema.safeParse(rawConfig || { agents: [] });
    if (!parsed.success) {
      logger.error('Invalid a2aAgents.json — refusing to load A2A client config', {
        component: 'A2aClientManager',
        errors: parsed.error.issues
      });
      this.security = { ...DEFAULT_SECURITY };
      await this.shutdown();
      this.initialized = true;
      return;
    }

    const securityChanged = JSON.stringify(parsed.data.security) !== JSON.stringify(this.security);
    this.security = parsed.data.security;
    const wanted = new Map(parsed.data.agents.map(agent => [agent.id, agent]));

    for (const [id, conn] of this.connections) {
      const next = wanted.get(id);
      if (!next || securityChanged || connectionChanged(conn.config, next)) {
        this.connections.delete(id);
      }
    }
    for (const [id, cfg] of wanted) {
      const existing = this.connections.get(id);
      if (existing) {
        // Same endpoint and credentials: rewire the allowlist, timeouts and
        // flags and rebuild the tools from the cached card.
        existing.config = cfg;
        existing.toolsCache = null;
        continue;
      }
      this.connections.set(id, new A2aAgentConnection(cfg, this.security));
    }

    this.initialized = true;
    logger.info('A2aClientManager initialised', {
      component: 'A2aClientManager',
      agentCount: this.connections.size
    });
  }

  /** Forget every connection and remembered conversation. */
  async shutdown() {
    this.connections.clear();
    this.contexts.clear();
  }

  /**
   * Fetch every enabled agent's card in the background at startup. Failures
   * are logged, never thrown: a dead agent must not keep iHub from starting.
   */
  async warmUp() {
    if (!this.initialized) return;
    await Promise.all(
      Array.from(this.connections.values())
        .filter(conn => conn.config.enabled !== false)
        .map(conn =>
          conn.getCard().catch(err => {
            logger.warn('Initial A2A Agent Card fetch failed; will retry lazily', {
              component: 'A2aClientManager',
              agentId: conn.config.id,
              error: err.message
            });
          })
        )
    );
  }

  /**
   * The tools of every enabled agent. An agent whose card cannot be fetched
   * contributes nothing and does not affect the others.
   * @returns {Promise<Array<Object>>}
   */
  async listAllTools() {
    if (!this.initialized) return [];
    const all = [];
    await Promise.all(
      Array.from(this.connections.values()).map(async conn => {
        if (conn.config.enabled === false) return;
        try {
          all.push(...(await conn.listTools()));
        } catch (err) {
          logger.warn('A2A skill discovery failed for agent', {
            component: 'A2aClientManager',
            agentId: conn.config.id,
            error: err.message
          });
        }
      })
    );
    const seen = new Set();
    return all.filter(tool => {
      if (seen.has(tool.id)) return false;
      seen.add(tool.id);
      return true;
    });
  }

  /**
   * Whether an agent with this id is configured.
   * @param {string} agentId
   * @returns {boolean}
   */
  hasAgent(agentId) {
    return this.connections.has(agentId);
  }

  /**
   * The connection for a configured agent id, or null.
   * @param {string} agentId
   * @returns {A2aAgentConnection|null}
   */
  getConnection(agentId) {
    if (!this.initialized) return null;
    return this.connections.get(agentId) || null;
  }

  /**
   * Resolve a tool id to its owning connection and tool definition.
   * @param {string} toolId
   * @returns {Promise<{conn: A2aAgentConnection, tool: Object}|null>}
   */
  async findTool(toolId) {
    if (!this.initialized || typeof toolId !== 'string') return null;
    for (const conn of this.connections.values()) {
      if (conn.config.enabled === false) continue;
      // The agent id sits between the prefix and the skill slug; only that
      // agent can own the tool, so no other card is fetched for the lookup.
      if (!toolId.startsWith(`a2a__${conn.config.id}__`)) continue;
      let tools;
      try {
        tools = await conn.listTools();
      } catch {
        continue;
      }
      const tool = tools.find(t => t.id === toolId);
      if (tool) return { conn, tool };
    }
    return null;
  }

  /**
   * Whether a tool id belongs to a configured agent whose tools are known.
   * @param {string} toolId
   * @returns {boolean}
   */
  ownsTool(toolId) {
    if (!this.initialized) return false;
    for (const conn of this.connections.values()) {
      if (conn.toolsCache?.some(t => t.id === toolId)) return true;
    }
    return false;
  }

  /**
   * Run a skill: send the tool's `message` (and `data`) to the owning agent
   * and return the agent's answer as text.
   *
   * The conversation with an agent continues across the tool calls of one
   * chat: the `contextId` of the agent's last answer is remembered for the
   * (user, chat, agent) triple and sent with the next message. It is never
   * shared across chats or users. iHub's own context keys (`user`, `chatId`,
   * `appConfig`, …) never leave iHub — only the message and data do.
   *
   * @param {string} toolId - `a2a__<agentId>__<skillSlug>`
   * @param {Object} params - Params as handed to `runTool`
   * @returns {Promise<string>}
   */
  async callTool(toolId, params = {}) {
    const found = await this.findTool(toolId);
    if (!found) throw new Error(`A2A tool not found: ${toolId}`);
    const { conn, tool } = found;

    const text = typeof params.message === 'string' ? params.message.trim() : '';
    if (!text) throw new Error(`Tool ${toolId} needs a non-empty "message"`);
    const data =
      params.data && typeof params.data === 'object' && !Array.isArray(params.data)
        ? params.data
        : undefined;

    const key = contextKey(params, conn.config.id);
    const contextId = key ? this.contexts.get(key) : undefined;
    if (key && contextId) this._remember(key, contextId); // refresh recency
    const chatId = typeof params.chatId === 'string' ? params.chatId : null;
    const agentName =
      getLocalizedString(tool._a2a.agentName, params.language || 'en') || conn.config.id;

    logger.info('Calling A2A agent skill', {
      component: 'A2aClientManager',
      toolId,
      agentId: conn.config.id,
      skillId: tool._a2a.skillId,
      continuing: Boolean(contextId)
    });

    const result = await conn.sendMessage({
      skillId: tool._a2a.skillId,
      text,
      data,
      contextId,
      onProgress: progress => {
        if (!chatId) return;
        emitToolProgress(chatId, {
          phase: PROGRESS_PHASE,
          message: progress.message || `${agentName}: ${progress.state || 'working'}`,
          data: { agentId: conn.config.id, skillId: tool._a2a.skillId, state: progress.state },
          toolId
        });
      }
    });
    if (key && result.contextId) this._remember(key, result.contextId);
    return result.text;
  }

  _remember(key, contextId) {
    this.contexts.delete(key);
    this.contexts.set(key, contextId);
    while (this.contexts.size > MAX_REMEMBERED_CONTEXTS) {
      this.contexts.delete(this.contexts.keys().next().value);
    }
  }

  /**
   * Snapshot used by the admin page.
   * @returns {Array<Object>}
   */
  status() {
    return Array.from(this.connections.values()).map(conn => conn.status());
  }

  /**
   * Per-agent skill catalog for the admin page and the app editor's picker.
   * Best-effort: an agent whose card cannot be fetched is listed with an
   * `error` and no skills.
   * @returns {Promise<Array<{id: string, name: *, description?: *, enabled: boolean, skills: Array, error: string|null}>>}
   */
  async listSkillsByAgent() {
    if (!this.initialized) return [];
    const out = [];
    await Promise.all(
      Array.from(this.connections.values()).map(async conn => {
        const entry = {
          id: conn.config.id,
          name: conn.config.name || conn.config.id,
          ...(conn.config.description ? { description: conn.config.description } : {}),
          enabled: conn.config.enabled !== false,
          skills: [],
          error: null
        };
        if (entry.enabled) {
          try {
            const tools = await conn.listTools();
            entry.skills = tools.map(tool =>
              summarizeSkill(conn.skillsByToolId.get(tool.id), tool.id)
            );
          } catch (err) {
            entry.error = err.message;
          }
        }
        out.push(entry);
      })
    );
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Re-fetch a saved agent's card and return its status, card and skills.
   * Used by the admin "Test connection" button on saved agents.
   * @param {string} agentId
   */
  async testConnection(agentId) {
    const conn = this.connections.get(agentId);
    if (!conn) throw new Error(`A2A agent not found: ${agentId}`);
    conn.reset();
    const card = await conn.getCard({ force: true });
    const tools = await conn.listTools();
    return {
      status: conn.status(),
      card: summarizeCard(card),
      skills: tools.map(tool => summarizeSkill(conn.skillsByToolId.get(tool.id), tool.id))
    };
  }

  /**
   * Probe an arbitrary (possibly unsaved) agent config without registering
   * it: fetch the card and list every skill it offers, marking which ones the
   * config's `allowedSkills` would expose.
   * @param {Object} rawAgentConfig
   */
  async testConfig(rawAgentConfig) {
    const parsed = a2aAgentConfigSchema.safeParse(rawAgentConfig);
    if (!parsed.success) {
      const err = new Error('Invalid agent config');
      err.details = parsed.error.issues;
      throw err;
    }
    const allow = parsed.data.allowedSkills || ['*'];
    const allowAll = allow.includes('*');
    const conn = new A2aAgentConnection(
      { ...parsed.data, enabled: true, allowedSkills: ['*'] },
      this.security
    );
    const card = await conn.getCard({ force: true });
    const tools = await conn.listTools();
    return {
      status: conn.status(),
      card: summarizeCard(card),
      skills: tools.map(tool => ({
        ...summarizeSkill(conn.skillsByToolId.get(tool.id), tool.id),
        allowed: allowAll || allow.includes(tool._a2a.skillId)
      }))
    };
  }
}

/** The (user, chat, agent) key a conversation is remembered under, or null. */
function contextKey(params, agentId) {
  const userId = params?.user?.id;
  const chatId = params?.chatId;
  if (typeof userId !== 'string' || !userId || typeof chatId !== 'string' || !chatId) return null;
  return `${userId}\u0000${chatId}\u0000${agentId}`;
}

function connectionChanged(a, b) {
  return a.cardUrl !== b.cardUrl || JSON.stringify(a.auth) !== JSON.stringify(b.auth);
}

const instance = new A2aClientManager();
export default instance;
