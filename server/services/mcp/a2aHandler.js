import path from 'path';
import { randomUUID } from 'crypto';
import configCache from '../../configCache.js';
import { MCP_SCOPES } from './scopes.js';
import { invokeApp, invokeAppNonStreaming } from './appInvoker.js';
import { runTool, loadConfiguredTools } from '../../toolLoader.js';
import { getVisibleToolIds, toolVisibleInSet } from './permissions.js';
import { isValidId } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import { getLocalizedString } from '../../utils/localize.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { getA2aTaskStore, taskStatus } from './a2aTaskStore.js';

// Tools that are surfaced as their own A2A skill kinds (apps/workflows) or
// that wrap filesystem access (skill meta-tools) must never be invocable as
// a raw tool via A2A. Mirrors McpServerService.isToolAllowed.
function isRawToolExposable(tool) {
  if (!tool || tool._mcp) return false;
  if (tool.id?.startsWith('workflow_')) return false;
  if (tool.id?.startsWith('source_')) return false;
  if (tool.id === 'activate_skill' || tool.id === 'read_skill_resource') return false;
  return true;
}

/**
 * Agent-to-Agent (A2A) protocol handler.
 *
 * The A2A wire protocol is JSON-RPC 2.0 over HTTP, task-oriented: a client
 * sends a Message, the agent answers with a Task (or a Message) it can poll
 * and cancel, and a `contextId` groups the messages of one conversation. This
 * module implements A2A 0.3.0 for iHub:
 *
 *   - Agent Card (`buildAgentCard`, served at `/.well-known/agent-card.json`
 *     and the gateway-scoped paths by routes/mcpServer.js) and
 *     `agent/getAuthenticatedExtendedCard` — the skills are the apps and
 *     workflows the caller may use
 *   - `message/send`           – run a skill, return the finished Task (or the
 *                                submitted one when `configuration.blocking`
 *                                is false)
 *   - `message/stream`         – the same over SSE: Task, then
 *                                `status-update` / `artifact-update` events
 *   - `tasks/get`              – a task the caller created
 *   - `tasks/cancel`           – abort a running task
 *
 * Which iHub skill a message runs comes from, in order: the per-skill endpoint
 * the request was sent to (`/a2a/skills/<skillId>`), `metadata.skillId` on the
 * params or the message, the skill the message's `contextId` is bound to, the
 * administrator's default (`platform.mcpServer.a2a.defaultSkill`), and finally
 * the caller's only skill when there is exactly one.
 *
 * The pre-0.3 draft methods (`agent/info`, `agent/skills`, `tasks/send`) are
 * still answered so existing callers keep working; they are deprecated.
 *
 * Auth + scope enforcement is handled by `mcpAuth`; this module assumes
 * `req.user` is populated and carries the relevant mcp:* scopes.
 */

export const A2A_PROTOCOL_VERSION = '0.3.0';

/** JSON-RPC and A2A-specific error codes (A2A specification §8). */
export const A2A_ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  EXTENDED_CARD_NOT_CONFIGURED: -32007
});

/** Skill id prefixes: an A2A skill is an iHub app or a workflow. */
const APP_SKILL_PREFIX = 'app__';
const WORKFLOW_SKILL_PREFIX = 'workflow__';

/** Per-model-call timeout and whole-task deadline for A2A-driven apps. */
const A2A_MODEL_TIMEOUT_MS = 120_000;
const A2A_TASK_WALL_CLOCK_MS = 10 * 60 * 1000;

/** Largest message text accepted (characters). */
const MAX_MESSAGE_CHARS = 200_000;

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return getLocalizedString(value, 'en');
  return String(value);
}

async function handleAgentInfo(_params, { user, platform }) {
  return {
    name: 'ihub-apps',
    version: '1.0.0',
    protocolVersion: '0.1-draft',
    description: 'iHub Apps platform exposed as an A2A agent',
    capabilities: {
      synchronousTasks: true,
      streamingTasks: false,
      taskState: false
    },
    auth: {
      scheme: 'oauth2',
      scopes: Object.values(MCP_SCOPES)
    },
    callerId: user.id,
    callerScopes: user.scopes || [],
    gateway: {
      mcpEndpoint: platform?.mcpServer?.publicUrl
        ? `${platform.mcpServer.publicUrl.replace(/\/$/, '')}/mcp`
        : null
    }
  };
}

async function handleAgentSkills(_params, { user, platform }) {
  const expose = platform?.mcpServer?.expose || {};
  const scopes = user.scopes || [];
  const skills = [];

  if (expose.tools && scopes.includes(MCP_SCOPES.TOOLS_READ)) {
    // local-only tools, gated by the apps the caller can access (default-deny)
    const visibleToolIds = await getVisibleToolIds(user, platform);
    const tools = await loadConfiguredTools(platform?.defaultLanguage || 'en');
    for (const t of tools) {
      if (!isRawToolExposable(t)) continue;
      if (!toolVisibleInSet(t.id, visibleToolIds)) continue;
      skills.push({
        id: t.id,
        kind: 'tool',
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: t.parameters || { type: 'object' }
      });
    }
  }

  if (expose.apps && scopes.includes(MCP_SCOPES.APPS_INVOKE)) {
    const { data: apps = [] } = configCache.getApps();
    const allowed = user?.permissions?.apps;
    for (const app of apps) {
      if (app.enabled === false) continue;
      if (!(allowed instanceof Set)) continue;
      if (!allowed.has('*') && !allowed.has(app.id)) continue;
      skills.push({
        id: `app__${app.id}`,
        kind: 'app',
        description: extractText(app.description) || extractText(app.name) || app.id,
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message']
        }
      });
    }
  }

  if (expose.workflows && scopes.includes(MCP_SCOPES.WORKFLOWS_RUN)) {
    const { data: workflows = [] } = configCache.getWorkflows(true);
    const allowed = user?.permissions?.workflows;
    for (const wf of workflows) {
      if (wf.enabled === false) continue;
      if (!wf.chatIntegration?.enabled) continue;
      if (!(allowed instanceof Set)) continue;
      if (!allowed.has('*') && !allowed.has(wf.id)) continue;
      skills.push({
        id: `workflow__${wf.id}`,
        kind: 'workflow',
        description:
          extractText(wf.chatIntegration?.toolDescription) || extractText(wf.description) || wf.id
      });
    }
  }

  return { skills };
}

async function handleTasksSend(params, { user, platform }) {
  // A2A draft `tasks/send` accepts { taskId, skillId, input, context }.
  // We treat it as synchronous: dispatch + return the result in `output`.
  if (!params || typeof params !== 'object') {
    return { __rpcError: { code: JSONRPC_INVALID_PARAMS, message: 'params required' } };
  }
  const { skillId, input } = params;
  if (typeof skillId !== 'string' || !skillId) {
    return { __rpcError: { code: JSONRPC_INVALID_PARAMS, message: 'skillId required' } };
  }

  // path.basename strips any directory separators / parent components and
  // is the canonical CodeQL-recognised sanitiser for path injection.
  const safeSkillId = path.basename(skillId);
  if (safeSkillId !== skillId) {
    return { __rpcError: { code: JSONRPC_INVALID_PARAMS, message: 'Invalid skillId' } };
  }

  try {
    let output;
    if (safeSkillId.startsWith('app__')) {
      if (!(user.scopes || []).includes(MCP_SCOPES.APPS_INVOKE)) {
        return {
          __rpcError: { code: -32004, message: 'insufficient_scope: mcp:apps:invoke required' }
        };
      }
      const appId = safeSkillId.slice('app__'.length);
      const safeAppId = path.basename(appId);
      if (safeAppId !== appId || !isValidId(safeAppId)) {
        return { __rpcError: { code: JSONRPC_INVALID_PARAMS, message: 'Invalid app id' } };
      }
      output = await invokeAppNonStreaming({
        appId: safeAppId,
        args: input || {},
        user,
        language: platform?.defaultLanguage || 'en'
      });
    } else if (safeSkillId.startsWith('workflow__')) {
      if (!(user.scopes || []).includes(MCP_SCOPES.WORKFLOWS_RUN)) {
        return {
          __rpcError: { code: -32004, message: 'insufficient_scope: mcp:workflows:run required' }
        };
      }
      const wfId = safeSkillId.slice('workflow__'.length);
      const safeWfId = path.basename(wfId);
      if (safeWfId !== wfId || !isValidId(safeWfId)) {
        return { __rpcError: { code: JSONRPC_INVALID_PARAMS, message: 'Invalid workflow id' } };
      }
      // Gate by the caller's workflow permission (group-based).
      const allowedWf = user?.permissions?.workflows;
      if (!(allowedWf instanceof Set) || (!allowedWf.has('*') && !allowedWf.has(safeWfId))) {
        return { __rpcError: { code: -32004, message: 'access_denied: workflow not permitted' } };
      }
      output = await runTool(`workflow_${safeWfId}`, input || {});
    } else {
      // Treat as a raw iHub tool id.
      if (!(user.scopes || []).includes(MCP_SCOPES.TOOLS_CALL)) {
        return {
          __rpcError: { code: -32004, message: 'insufficient_scope: mcp:tools:call required' }
        };
      }
      if (!isValidId(safeSkillId)) {
        return { __rpcError: { code: JSONRPC_INVALID_PARAMS, message: 'Invalid skill id' } };
      }
      // Gate by the apps the caller can access — same default-deny model as
      // the MCP gateway. This also prevents reaching workflow_/source_/skill
      // meta-tools (e.g. read_skill_resource) via A2A, which would otherwise
      // pass user-controlled paths into the skill loader.
      const visibleToolIds = await getVisibleToolIds(user, platform);
      const configuredTools = await loadConfiguredTools(platform?.defaultLanguage || 'en');
      const toolDef = configuredTools.find(tdef => tdef.id === safeSkillId);
      if (
        !toolDef ||
        !isRawToolExposable(toolDef) ||
        !toolVisibleInSet(safeSkillId, visibleToolIds)
      ) {
        return { __rpcError: { code: -32004, message: 'access_denied: tool not permitted' } };
      }
      output = await runTool(safeSkillId, input || {});
    }

    return {
      taskId: params.taskId || `task-${Date.now()}`,
      status: 'completed',
      output: typeof output === 'string' ? output : JSON.stringify(output)
    };
  } catch (err) {
    logger.warn('A2A tasks/send failed', {
      component: 'A2A',
      skillId,
      user: user.id,
      error: err.message
    });
    return {
      taskId: params?.taskId || `task-${Date.now()}`,
      status: 'failed',
      error: err.message || 'task execution failed'
    };
  }
}

// ---------------------------------------------------------------------------
// A2A 0.3 — skills, Agent Card, messages, tasks
// ---------------------------------------------------------------------------

/** An error a handler throws to answer with a specific JSON-RPC code. */
export class A2aError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function invalidParams(message) {
  return new A2aError(A2A_ERRORS.INVALID_PARAMS, message);
}

function userHasScope(user, scope) {
  return Array.isArray(user?.scopes) && user.scopes.includes(scope);
}

function permitted(set, id) {
  return set instanceof Set && (set.has('*') || set.has(id));
}

/**
 * Whether a skill id is well-formed: `app__<id>` or `workflow__<id>` with a
 * safe inner id. Path-traversal sequences and separators never get past this.
 * @param {unknown} skillId
 * @returns {{kind: 'app'|'workflow', id: string}|null}
 */
export function parseSkillId(skillId) {
  if (typeof skillId !== 'string' || skillId.length > 200) return null;
  if (path.basename(skillId) !== skillId) return null;
  let kind;
  let id;
  if (skillId.startsWith(APP_SKILL_PREFIX)) {
    kind = 'app';
    id = skillId.slice(APP_SKILL_PREFIX.length);
  } else if (skillId.startsWith(WORKFLOW_SKILL_PREFIX)) {
    kind = 'workflow';
    id = skillId.slice(WORKFLOW_SKILL_PREFIX.length);
  } else {
    return null;
  }
  if (path.basename(id) !== id || !isValidId(id)) return null;
  return { kind, id };
}

/**
 * The app skills the caller may run: the gateway exposes apps, the token
 * carries `mcp:apps:invoke`, and the caller's groups grant the app.
 */
function appSkillsFor(user, platform, language) {
  const expose = platform?.mcpServer?.expose || {};
  if (!expose.apps || !userHasScope(user, MCP_SCOPES.APPS_INVOKE)) return [];
  const { data: apps = [] } = configCache.getApps();
  const allowed = user?.permissions?.apps;
  const skills = [];
  for (const app of apps) {
    if (app.enabled === false || !permitted(allowed, app.id)) continue;
    const examples = (Array.isArray(app.starterPrompts) ? app.starterPrompts : [])
      .map(p => getLocalizedString(p?.message, language))
      .filter(text => typeof text === 'string' && text.trim())
      .slice(0, 5);
    skills.push({
      id: `${APP_SKILL_PREFIX}${app.id}`,
      name: getLocalizedString(app.name, language) || app.id,
      description:
        getLocalizedString(app.description, language) ||
        getLocalizedString(app.name, language) ||
        app.id,
      tags: ['app'],
      ...(examples.length ? { examples } : {}),
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      _kind: 'app',
      _id: app.id
    });
  }
  return skills;
}

/**
 * The workflow skills the caller may run: exposed, `mcp:workflows:run`,
 * chat integration on, and the caller's groups grant the workflow.
 */
function workflowSkillsFor(user, platform, language) {
  const expose = platform?.mcpServer?.expose || {};
  if (!expose.workflows || !userHasScope(user, MCP_SCOPES.WORKFLOWS_RUN)) return [];
  const { data: workflows = [] } = configCache.getWorkflows(true);
  const allowed = user?.permissions?.workflows;
  const skills = [];
  for (const wf of workflows) {
    if (wf.enabled === false || !wf.chatIntegration?.enabled) continue;
    if (!permitted(allowed, wf.id)) continue;
    skills.push({
      id: `${WORKFLOW_SKILL_PREFIX}${wf.id}`,
      name: getLocalizedString(wf.name, language) || wf.id,
      description:
        getLocalizedString(wf.chatIntegration?.toolDescription, language) ||
        getLocalizedString(wf.description, language) ||
        wf.id,
      tags: ['workflow'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      _kind: 'workflow',
      _id: wf.id
    });
  }
  return skills;
}

/**
 * The A2A skills (apps and workflows) the caller may use, resolved against the
 * gateway's exposure settings, the token's scopes and the caller's groups.
 *
 * @param {Object} user - Authenticated caller (`req.user`)
 * @param {Object} platform - Platform config
 * @param {Object} [options]
 * @param {string} [options.language]
 * @returns {Array<Object>} Skills with internal `_kind`/`_id` markers
 */
export function listA2aSkills(user, platform, { language } = {}) {
  const lang = language || platform?.defaultLanguage || 'en';
  return [...appSkillsFor(user, platform, lang), ...workflowSkillsFor(user, platform, lang)];
}

/** Strip the internal markers off a skill before it leaves the server. */
function publicSkill(skill) {
  const { _kind: _k, _id: _i, ...rest } = skill;
  return rest;
}

/** The product name shown on the Agent Card. */
function agentName() {
  const ui = configCache.getUI?.();
  const title = getLocalizedString(ui?.data?.title ?? ui?.title, 'en');
  return title || 'iHub Apps';
}

/**
 * Build the Agent Card (A2A 0.3.0 `AgentCard`).
 *
 * Without a caller the card is public: it names the endpoint, the protocol
 * version, the capabilities and how to authenticate, and lists no skills — a
 * client fetches `agent/getAuthenticatedExtendedCard` (or the card again with
 * credentials) to see the skills its token gives it.
 *
 * @param {Object} params
 * @param {string} params.baseUrl - Public base URL of this iHub (no trailing slash)
 * @param {Object} params.platform - Platform config
 * @param {Object} [params.user] - Authenticated caller; skills are listed for them
 * @param {string} [params.skillId] - Per-skill card: the endpoint is bound to this skill
 * @param {string} [params.language]
 * @returns {Object} AgentCard
 * @throws {A2aError} INVALID_PARAMS when `skillId` is unknown to the caller
 */
export function buildAgentCard({ baseUrl, platform, user = null, skillId = null, language }) {
  const issuer =
    platform?.oauth?.issuer && String(platform.oauth.issuer).startsWith('http')
      ? String(platform.oauth.issuer).replace(/\/$/, '')
      : baseUrl;
  const scopes = {
    [MCP_SCOPES.APPS_INVOKE]: 'Run iHub apps',
    [MCP_SCOPES.WORKFLOWS_RUN]: 'Run iHub workflows'
  };
  let skills = user ? listA2aSkills(user, platform, { language }) : [];
  if (skillId) {
    if (!parseSkillId(skillId)) throw invalidParams(`Invalid skill id: ${skillId}`);
    if (user) {
      skills = skills.filter(skill => skill.id === skillId);
      if (skills.length === 0) throw invalidParams(`Unknown skill: ${skillId}`);
    }
  }
  const skillPath = skillId ? `/a2a/skills/${encodeURIComponent(skillId)}` : '/a2a';
  const name = agentName();
  const one = skillId && skills[0];
  return {
    name: one ? `${name} — ${one.name}` : name,
    description: one
      ? one.description
      : `${name} exposed as an A2A agent: its apps and workflows are the agent's skills. Pass metadata.skillId on a message to choose one, or use a per-skill endpoint.`,
    url: `${baseUrl}${skillPath}`,
    preferredTransport: 'JSONRPC',
    protocolVersion: A2A_PROTOCOL_VERSION,
    version: getAppVersion(),
    provider: { organization: name, url: baseUrl },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    securitySchemes: {
      oauth2: {
        type: 'oauth2',
        description:
          "iHub's OAuth 2.0 authorization server (authorization code with PKCE for users, client credentials for services)",
        oauth2MetadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
        flows: {
          authorizationCode: {
            authorizationUrl: `${issuer}/api/oauth/authorize`,
            tokenUrl: `${issuer}/api/oauth/token`,
            refreshUrl: `${issuer}/api/oauth/token`,
            scopes
          },
          clientCredentials: { tokenUrl: `${issuer}/api/oauth/token`, scopes }
        }
      },
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'An iHub personal API key or OAuth access token'
      },
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'An iHub personal API key'
      }
    },
    security: [{ oauth2: Object.keys(scopes) }, { bearer: [] }, { apiKey: [] }],
    supportsAuthenticatedExtendedCard: true,
    skills: skills.map(publicSkill)
  };
}

// ── messages ────────────────────────────────────────────────────────────────

/** The text of a message: its text parts, joined. */
function messageText(message) {
  return (message.parts || [])
    .filter(part => part?.kind === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

/** The structured data of a message: its data parts, merged in order. */
function messageData(message) {
  const out = {};
  for (const part of message.parts || []) {
    if (part?.kind === 'data' && part.data && typeof part.data === 'object') {
      Object.assign(out, part.data);
    }
  }
  return out;
}

/**
 * Validate the incoming A2A Message and normalise it for storage.
 * @throws {A2aError}
 */
function normalizeIncomingMessage(params) {
  if (!params || typeof params !== 'object') throw invalidParams('params required');
  const message = params.message;
  if (!message || typeof message !== 'object') throw invalidParams('message required');
  if (message.role !== undefined && message.role !== 'user') {
    throw invalidParams("message.role must be 'user'");
  }
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw invalidParams('message.parts must be a non-empty array');
  }
  for (const part of message.parts) {
    if (!part || typeof part !== 'object') throw invalidParams('Invalid message part');
    if (part.kind === 'file') {
      throw new A2aError(
        A2A_ERRORS.CONTENT_TYPE_NOT_SUPPORTED,
        'File parts are not supported; send text (and data) parts'
      );
    }
    if (part.kind !== 'text' && part.kind !== 'data') {
      throw invalidParams(`Unsupported part kind: ${String(part.kind)}`);
    }
  }
  const text = messageText(message);
  if (!text) throw invalidParams('message has no text');
  if (text.length > MAX_MESSAGE_CHARS) throw invalidParams('message text too long');
  for (const key of ['contextId', 'taskId', 'messageId']) {
    const value = message[key];
    if (value !== undefined && (typeof value !== 'string' || !value || value.length > 200)) {
      throw invalidParams(`message.${key} must be a non-empty string`);
    }
    if (typeof value === 'string' && !isValidId(value)) {
      throw invalidParams(`message.${key} contains unsupported characters`);
    }
  }
  return {
    text,
    data: messageData(message),
    stored: {
      kind: 'message',
      role: 'user',
      messageId: message.messageId || randomUUID(),
      parts: message.parts,
      ...(message.contextId ? { contextId: message.contextId } : {}),
      ...(message.taskId ? { taskId: message.taskId } : {}),
      ...(message.metadata && typeof message.metadata === 'object'
        ? { metadata: message.metadata }
        : {})
    }
  };
}

/**
 * Decide which skill a message runs (see the module doc for the order) and
 * check that the caller may use it.
 *
 * @returns {Object} The resolved skill (with `_kind`/`_id`)
 * @throws {A2aError}
 */
function resolveSkill({ params, message, context, fixedSkillId, user, platform }) {
  const explicit = params.metadata?.skillId ?? message.metadata?.skillId;
  if (explicit !== undefined && typeof explicit !== 'string') {
    throw invalidParams('metadata.skillId must be a string');
  }
  if (fixedSkillId && explicit && explicit !== fixedSkillId) {
    throw invalidParams(
      `This endpoint runs skill ${fixedSkillId}; metadata.skillId ${explicit} does not match`
    );
  }
  const skills = listA2aSkills(user, platform);
  const configured = platform?.mcpServer?.a2a?.defaultSkill;
  const wanted =
    fixedSkillId ||
    explicit ||
    context?.skillId ||
    (typeof configured === 'string' && configured) ||
    (skills.length === 1 ? skills[0].id : null);
  if (!wanted) {
    throw invalidParams(
      skills.length === 0
        ? 'No skill available to this caller'
        : 'No skill selected: pass metadata.skillId (see the Agent Card for your skills) or ask the administrator to configure a default skill'
    );
  }
  if (!parseSkillId(wanted)) throw invalidParams(`Invalid skill id: ${wanted}`);
  const skill = skills.find(entry => entry.id === wanted);
  if (!skill) {
    throw invalidParams(
      `Unknown skill: ${wanted}. Fetch the Agent Card for the skills available to you`
    );
  }
  return skill;
}

/** History of a context as chat messages for an app. */
function contextMessages(context) {
  const out = [];
  for (const message of context?.history || []) {
    const text = messageText(message);
    if (!text) continue;
    out.push({ role: message.role === 'agent' ? 'assistant' : 'user', content: text });
  }
  return out;
}

/** A Task as returned to the client, with its history trimmed as requested. */
function presentTask(task, historyLength) {
  if (!task) return task;
  const out = { ...task };
  if (Number.isInteger(historyLength) && historyLength >= 0) {
    out.history = historyLength === 0 ? [] : (task.history || []).slice(-historyLength);
  }
  return out;
}

function agentMessage(text, { contextId, taskId }) {
  return {
    kind: 'message',
    role: 'agent',
    messageId: randomUUID(),
    parts: [{ kind: 'text', text }],
    contextId,
    taskId
  };
}

function isAbort(error) {
  return (
    error?.name === 'AbortError' ||
    /abort|cancel/i.test(String(error?.message || '')) ||
    error?.code === 'ABORT_ERR'
  );
}

/**
 * Run the skill for a task and drive the task through its states, emitting
 * A2A streaming events on the way when `emit` is given.
 */
async function runTask({ task, skill, text, data, userMessage, user, platform, store, emit }) {
  const controller = new AbortController();
  store.registerRun(task.id, controller);
  const language = platform?.defaultLanguage || 'en';
  const { contextId } = task;
  const artifactId = randomUUID();
  let streamed = '';

  const send = event => {
    if (typeof emit === 'function') emit(event);
  };

  await store.setStatus(task.id, 'working');
  send({
    kind: 'status-update',
    taskId: task.id,
    contextId,
    status: taskStatus('working'),
    final: false
  });

  let finalState = 'completed';
  let statusMessage = null;
  try {
    let answer;
    if (skill._kind === 'app') {
      const history = contextMessages(await store.getContext(contextId, user.id));
      const { text: result } = await invokeApp({
        appId: skill._id,
        messages: [...history, { role: 'user', content: text }],
        variables: data,
        user,
        language,
        runId: `a2a-${task.id}`,
        timeoutMs: A2A_MODEL_TIMEOUT_MS,
        maxWallClockMs: A2A_TASK_WALL_CLOCK_MS,
        abortSignal: controller.signal,
        onTextDelta: emit
          ? delta => {
              send({
                kind: 'artifact-update',
                taskId: task.id,
                contextId,
                artifact: { artifactId, name: 'response', parts: [{ kind: 'text', text: delta }] },
                append: streamed.length > 0,
                lastChunk: false
              });
              streamed += delta;
            }
          : undefined
      });
      answer = result;
    } else {
      const output = await runTool(`workflow_${skill._id}`, {
        input: text,
        ...data,
        user,
        chatId: `a2a-${task.id}`,
        language
      });
      answer = typeof output === 'string' ? output : JSON.stringify(output);
    }
    if (controller.signal.aborted) throw new A2aError(A2A_ERRORS.INTERNAL, 'Task cancelled');

    const artifact = { artifactId, name: 'response', parts: [{ kind: 'text', text: answer }] };
    // Streamed fragments came from every model step; the artifact is the
    // final answer. When they differ, the last event replaces what was
    // streamed (append: false); otherwise it just closes the artifact.
    if (streamed === answer) {
      send({
        kind: 'artifact-update',
        taskId: task.id,
        contextId,
        artifact: { artifactId, name: 'response', parts: [] },
        append: true,
        lastChunk: true
      });
    } else {
      send({
        kind: 'artifact-update',
        taskId: task.id,
        contextId,
        artifact,
        append: false,
        lastChunk: true
      });
    }
    statusMessage = agentMessage(answer, { contextId, taskId: task.id });
    await store.setArtifact(task.id, artifact);
    const updated = await store.setStatus(task.id, 'completed', statusMessage);
    finalState = updated?.status?.state || 'completed';
    if (finalState === 'completed') {
      await store.appendToContext({
        contextId,
        ownerId: user.id,
        skillId: skill.id,
        messages: [userMessage, statusMessage]
      });
    }
  } catch (error) {
    const cancelled = controller.signal.aborted || isAbort(error);
    finalState = cancelled ? 'canceled' : 'failed';
    logger.warn('A2A task failed', {
      component: 'A2A',
      taskId: task.id,
      skillId: skill.id,
      userId: user.id,
      state: finalState,
      error: error.message
    });
    statusMessage = cancelled
      ? null
      : agentMessage(`Task failed: ${error.message || 'unknown error'}`, {
          contextId,
          taskId: task.id
        });
    const updated = await store.setStatus(task.id, finalState, statusMessage || undefined);
    finalState = updated?.status?.state || finalState;
  } finally {
    store.releaseRun(task.id);
  }
  const finalTask = await store.getTask(task.id, user.id);
  send({
    kind: 'status-update',
    taskId: task.id,
    contextId,
    status: finalTask?.status || taskStatus(finalState, statusMessage || undefined),
    final: true
  });
  return finalTask;
}

/**
 * `message/send` and `message/stream`. With `emit`, events are streamed and
 * the returned promise resolves when the task is final; without it the
 * finished Task is returned (or the submitted one when non-blocking).
 */
async function handleMessage(params, { user, platform, fixedSkillId, store, emit }) {
  const { text, data, stored } = normalizeIncomingMessage(params);
  const configuration =
    params.configuration && typeof params.configuration === 'object' ? params.configuration : {};
  if (configuration.pushNotificationConfig) {
    throw new A2aError(A2A_ERRORS.PUSH_NOT_SUPPORTED, 'Push notifications are not supported');
  }
  if (stored.taskId) {
    const existing = await store.getTask(stored.taskId, user.id);
    if (!existing)
      throw new A2aError(A2A_ERRORS.TASK_NOT_FOUND, `Task not found: ${stored.taskId}`);
    throw invalidParams(
      `Task ${stored.taskId} is ${existing.status?.state} and does not accept further messages; start a new task in the same contextId instead`
    );
  }
  const context = stored.contextId ? await store.getContext(stored.contextId, user.id) : null;
  const skill = resolveSkill({ params, message: stored, context, fixedSkillId, user, platform });

  const task = await store.createTask({
    ownerId: user.id,
    skillId: skill.id,
    contextId: stored.contextId,
    message: stored
  });
  const userMessage = { ...stored, contextId: task.contextId, taskId: task.id };
  await store.updateTask(task.id, t => {
    t.history = [userMessage];
  });

  logger.info('A2A task created', {
    component: 'A2A',
    taskId: task.id,
    contextId: task.contextId,
    skillId: skill.id,
    userId: user.id,
    streaming: typeof emit === 'function',
    blocking: configuration.blocking !== false
  });

  const run = () =>
    runTask({
      task: { ...task, history: [userMessage] },
      skill,
      text,
      data,
      userMessage,
      user,
      platform,
      store,
      emit
    });

  if (typeof emit === 'function') {
    emit({ ...task, history: [userMessage] });
    await run();
    return null;
  }
  if (configuration.blocking === false) {
    run().catch(error =>
      logger.error('A2A background task crashed', {
        component: 'A2A',
        taskId: task.id,
        error: error.message
      })
    );
    return presentTask({ ...task, history: [userMessage] }, configuration.historyLength);
  }
  const finished = await run();
  return presentTask(finished || task, configuration.historyLength);
}

async function handleTasksGet(params, { user, store }) {
  const id = params?.id;
  if (typeof id !== 'string' || !id) throw invalidParams('id required');
  const task = await store.getTask(id, user.id);
  if (!task) throw new A2aError(A2A_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`);
  return presentTask(task, params.historyLength);
}

async function handleTasksCancel(params, { user, store }) {
  const id = params?.id;
  if (typeof id !== 'string' || !id) throw invalidParams('id required');
  const { task, cancelable } = await store.cancelTask(id, user.id);
  if (!task) throw new A2aError(A2A_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`);
  if (!cancelable) {
    throw new A2aError(
      A2A_ERRORS.TASK_NOT_CANCELABLE,
      `Task ${id} is already ${task.status?.state}`
    );
  }
  return task;
}

/**
 * Dispatch a single JSON-RPC request. Returns a JSON-RPC response object
 * (with either `result` or `error`), or — for `message/stream` with a
 * `stream` callback — `null` after every event was handed to `stream`.
 *
 * @param {Object} message - JSON-RPC request
 * @param {Object} context
 * @param {Object} context.user - Authenticated caller
 * @param {Object} context.platform - Platform config
 * @param {string} [context.baseUrl] - Public base URL (Agent Card)
 * @param {string} [context.fixedSkillId] - Skill the endpoint is bound to (`/a2a/skills/<id>`)
 * @param {(event: Object) => void} [context.stream] - Receives `message/stream` events, each
 *   already wrapped as a JSON-RPC response; without it `message/stream` is refused
 * @param {import('./a2aTaskStore.js').A2aTaskStore} [context.store]
 * @returns {Promise<Object|null>}
 */
export async function dispatchA2A(
  message,
  { user, platform, baseUrl, fixedSkillId, stream, store }
) {
  if (!message || typeof message !== 'object') {
    return rpcError(null, JSONRPC_PARSE_ERROR, 'Invalid JSON-RPC message');
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message.id, JSONRPC_INVALID_REQUEST, 'Not a JSON-RPC 2.0 request');
  }
  const taskStore = store || getA2aTaskStore();
  const ctx = { user, platform, baseUrl, fixedSkillId, store: taskStore };

  try {
    let handler;
    switch (message.method) {
      case 'message/send':
        handler = handleMessage;
        break;
      case 'message/stream': {
        if (typeof stream !== 'function') {
          return rpcError(
            message.id,
            JSONRPC_INVALID_REQUEST,
            'message/stream needs a streaming response (Accept: text/event-stream) and cannot be batched'
          );
        }
        await handleMessage(message.params, {
          ...ctx,
          emit: event => stream(rpcResult(message.id, event))
        });
        return null;
      }
      case 'tasks/get':
        handler = handleTasksGet;
        break;
      case 'tasks/cancel':
        handler = handleTasksCancel;
        break;
      case 'agent/getAuthenticatedExtendedCard':
        handler = () =>
          buildAgentCard({
            baseUrl: baseUrl || '',
            platform,
            user,
            skillId: fixedSkillId || null,
            language: platform?.defaultLanguage
          });
        break;
      case 'tasks/resubscribe':
      case 'tasks/pushNotificationConfig/set':
      case 'tasks/pushNotificationConfig/get':
      case 'tasks/pushNotificationConfig/list':
      case 'tasks/pushNotificationConfig/delete':
        return rpcError(
          message.id,
          message.method === 'tasks/resubscribe'
            ? A2A_ERRORS.UNSUPPORTED_OPERATION
            : A2A_ERRORS.PUSH_NOT_SUPPORTED,
          `${message.method} is not supported`
        );
      // Pre-0.3 draft methods, kept for existing callers (deprecated).
      case 'agent/info':
        handler = handleAgentInfo;
        break;
      case 'agent/skills':
        handler = handleAgentSkills;
        break;
      case 'tasks/send':
        handler = handleTasksSend;
        break;
      default:
        return rpcError(
          message.id,
          JSONRPC_METHOD_NOT_FOUND,
          `Method not found: ${message.method}`
        );
    }

    const result = await handler(message.params, ctx);
    if (result?.__rpcError) {
      return rpcError(message.id, result.__rpcError.code, result.__rpcError.message);
    }
    return rpcResult(message.id, result);
  } catch (err) {
    if (err instanceof A2aError) {
      return rpcError(message.id, err.code, err.message, err.data);
    }
    logger.error('A2A dispatch error', {
      component: 'A2A',
      method: message.method,
      error: err.message
    });
    return rpcError(message.id, JSONRPC_INTERNAL_ERROR, err.message || 'internal error');
  }
}
