import path from 'path';
import configCache from '../../configCache.js';
import { MCP_SCOPES } from './scopes.js';
import { invokeAppNonStreaming } from './appInvoker.js';
import { runTool, loadConfiguredTools } from '../../toolLoader.js';
import { getVisibleToolIds, toolVisibleInSet } from './permissions.js';
import { isValidId } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';

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
 * The A2A wire protocol is JSON-RPC 2.0 over HTTP, modelled after MCP but
 * task-oriented (long-running tasks with state, vs. MCP's synchronous
 * tools/call). The spec is still v0.x and methods are evolving; this
 * module implements the well-defined subset:
 *
 *   - `agent/info`        – static capabilities + skills card
 *   - `agent/skills`      – enumerate iHub tools/apps/workflows as skills
 *   - `tasks/send`        – synchronous "send + wait" tool/app invocation
 *
 * Stateful tasks (`tasks/get`, `tasks/cancel`, streaming `tasks/sendSubscribe`)
 * need a persistent task store and are deferred until the A2A spec
 * stabilises. Calls to unknown methods return JSON-RPC method-not-found.
 *
 * Auth + scope enforcement is handled by `mcpAuth`; this module assumes
 * `req.user` is populated and carries the relevant mcp:* scopes.
 */

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
  if (typeof value === 'object') {
    return value.en || value.de || Object.values(value)[0] || '';
  }
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

/**
 * Dispatch a single JSON-RPC request. Returns a JSON-RPC response object
 * (with either `result` or `error`).
 */
export async function dispatchA2A(message, { user, platform }) {
  if (!message || typeof message !== 'object') {
    return rpcError(null, JSONRPC_PARSE_ERROR, 'Invalid JSON-RPC message');
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message.id, JSONRPC_INVALID_REQUEST, 'Not a JSON-RPC 2.0 request');
  }

  try {
    let handler;
    switch (message.method) {
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
          `Method not supported in this A2A scaffold: ${message.method}`
        );
    }

    const result = await handler(message.params, { user, platform });
    if (result?.__rpcError) {
      return rpcError(message.id, result.__rpcError.code, result.__rpcError.message);
    }
    return rpcResult(message.id, result);
  } catch (err) {
    logger.error('A2A dispatch error', {
      component: 'A2A',
      method: message.method,
      error: err.message
    });
    return rpcError(message.id, JSONRPC_INTERNAL_ERROR, err.message || 'internal error');
  }
}
