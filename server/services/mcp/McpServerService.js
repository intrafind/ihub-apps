import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import configCache from '../../configCache.js';
import { loadConfiguredTools, runTool } from '../../toolLoader.js';
import { actionTracker } from '../../actionTracker.js';
import { invokeAppNonStreaming } from './appInvoker.js';
import { listMcpResources, readMcpResource } from './resourceAdapter.js';
import { getVisibleToolIds, toolVisibleInSet } from './permissions.js';
import { MCP_SCOPES } from './scopes.js';
import logger from '../../utils/logger.js';

/**
 * Builds and serves the iHub MCP gateway. Each incoming HTTP/SSE request
 * gets a fresh `McpServer` instance whose tool/resource registry is filtered
 * by the caller's identity (req.user) so two different OAuth clients
 * connecting concurrently never see each other's resources.
 *
 * Per-request server construction is deliberate:
 *   - Permissions are derived from req.user.permissions, which differs by
 *     caller, so a shared registry would leak resources.
 *   - The SDK's `registerTool` accepts a callback; if the callback closes
 *     over req.user the closures stay correct even under concurrent calls.
 */

/**
 * Convert an iHub tool definition (`tool.parameters` is JSON Schema) into
 * MCP's `inputSchema` shape (zod or JSON Schema both work). We pass JSON
 * Schema directly since the SDK accepts it via `inputSchema`.
 */
function jsonSchemaToInputSchema(jsonSchema) {
  // SDK accepts a Zod raw shape OR an `AnySchema` (with a JSON Schema). Pass
  // through the JSON Schema by wrapping in a thin AnySchema object.
  if (!jsonSchema || typeof jsonSchema !== 'object') {
    return { jsonSchema: { type: 'object', properties: {} } };
  }
  return { jsonSchema };
}

function buildAppToolName(appId) {
  return `app__${appId}`;
}

function buildWorkflowToolName(workflowId) {
  return `workflow__${workflowId}`;
}

/**
 * Build a JSON Schema for an iHub app's `tools/call` input from its
 * `variables` array. We only need `message` plus declared variables — the
 * model passes message text via the MCP tool argument.
 */
function buildAppInputSchema(app) {
  const properties = {
    message: {
      type: 'string',
      description: 'User message / prompt sent to the iHub app'
    }
  };
  const required = ['message'];
  if (Array.isArray(app.variables)) {
    for (const v of app.variables) {
      if (!v?.name) continue;
      properties[v.name] = {
        type: v.type === 'number' ? 'number' : 'string',
        description: v.description || v.label || v.name
      };
      if (v.required) required.push(v.name);
    }
  }
  return { type: 'object', properties, required };
}

/**
 * Determine whether a caller may see a given iHub tool. iHub scopes tools
 * through the apps that reference them, so `visibleToolIds` is the union of
 * tool ids across the apps this caller can access (see ./permissions.js).
 *
 * Default-deny: a tool the caller has no app-granted access to is never
 * exposed, even with the `mcp:tools:*` scopes. This closes the gap where
 * OAuth client-credentials tokens (which carry no group `tools` permission)
 * would otherwise see every tool on the platform.
 */
function isToolAllowed(tool, expose, visibleToolIds) {
  if (!expose.tools) return false;
  // workflow_/source_/skill tools are surfaced as their own MCP tool/resource
  // types, not as raw tools.
  if (tool.id?.startsWith('workflow_')) return false;
  if (tool.id?.startsWith('source_')) return false;
  if (tool.id === 'activate_skill' || tool.id === 'read_skill_resource') return false;
  // Never re-expose tools discovered from external (outbound) MCP servers —
  // that would proxy another server's tools (and their credentials) to inbound
  // callers. loadConfiguredTools already excludes these, but guard anyway.
  if (tool._mcp) return false;
  return toolVisibleInSet(tool.id, visibleToolIds);
}

function isAppAllowed(app, user, expose) {
  if (!expose.apps) return false;
  if (app.enabled === false) return false;
  const allowed = user?.permissions?.apps;
  if (!(allowed instanceof Set)) return false;
  return allowed.has('*') || allowed.has(app.id);
}

function isWorkflowAllowed(wf, user, expose) {
  if (!expose.workflows) return false;
  if (wf.enabled === false) return false;
  if (!wf.chatIntegration?.enabled) return false;
  const allowed = user?.permissions?.workflows;
  if (!(allowed instanceof Set)) return false;
  return allowed.has('*') || allowed.has(wf.id);
}

/**
 * Build the per-request MCP server bound to a specific authenticated user.
 *
 * @param {object} ctx - Build context.
 * @param {object} ctx.user - Enhanced user object (req.user after
 *   enhanceUserWithPermissions). MUST NOT be anonymous; mcpAuth enforces this.
 * @param {object} ctx.platform - Platform config (configCache.getPlatform()).
 * @returns {Promise<McpServer>}
 */
export async function buildMcpServer({ user, platform }) {
  if (!user || user.id === 'anonymous') {
    // Defence in depth — mcpAuth should already have rejected anonymous.
    throw new Error('MCP gateway requires an authenticated user');
  }

  const gateway = platform?.mcpServer || {};
  const expose = gateway.expose || { tools: true, apps: true, workflows: true, resources: false };
  const tokenScopes = user.scopes || [];

  const server = new McpServer(
    { name: 'ihub-apps', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } }
  );

  // ---- Tools (iHub-native, local-only) ------------------------------------
  // loadConfiguredTools excludes outbound MCP-discovered tools so the gateway
  // never re-proxies another server's tools to inbound callers.
  if (expose.tools && tokenScopes.includes(MCP_SCOPES.TOOLS_READ)) {
    const visibleToolIds = await getVisibleToolIds(user, platform);
    const tools = await loadConfiguredTools(platform?.defaultLanguage || 'en');
    for (const tool of tools) {
      if (!isToolAllowed(tool, expose, visibleToolIds)) continue;
      server.registerTool(
        tool.id,
        {
          description: typeof tool.description === 'string' ? tool.description : '',
          ...jsonSchemaToInputSchema(tool.parameters)
        },
        async args => {
          if (!tokenScopes.includes(MCP_SCOPES.TOOLS_CALL)) {
            return toolErrorResult('insufficient_scope: mcp:tools:call required');
          }
          // Re-check visibility at call time so a permission change between
          // list and call can't be exploited.
          if (!toolVisibleInSet(tool.id, visibleToolIds)) {
            return toolErrorResult('access_denied: tool not permitted for this caller');
          }
          try {
            const result = await runTool(tool.id, args || {});
            return toolSuccessResult(result);
          } catch (err) {
            logger.warn('MCP gateway tool call failed', {
              component: 'McpServerService',
              toolId: tool.id,
              user: user.id,
              error: err.message
            });
            return toolErrorResult(err.message || 'tool execution failed');
          }
        }
      );
    }
  }

  // ---- Apps (exposed as MCP tools) ----------------------------------------
  if (expose.apps && tokenScopes.includes(MCP_SCOPES.APPS_INVOKE)) {
    const { data: apps = [] } = configCache.getApps();
    for (const app of apps) {
      if (!isAppAllowed(app, user, expose)) continue;
      server.registerTool(
        buildAppToolName(app.id),
        {
          description:
            extractText(app.description) || extractText(app.name) || `iHub app: ${app.id}`,
          ...jsonSchemaToInputSchema(buildAppInputSchema(app))
        },
        async args => {
          // Re-check scope + permission at call time so a token that loses the
          // scope, or a user removed from the app's groups, between list and
          // call can't still invoke it (mirrors the tools handler above).
          if (!tokenScopes.includes(MCP_SCOPES.APPS_INVOKE)) {
            return toolErrorResult('insufficient_scope: mcp:apps:invoke required');
          }
          if (!isAppAllowed(app, user, expose)) {
            return toolErrorResult('access_denied: app not permitted for this caller');
          }
          try {
            const text = await invokeAppNonStreaming({
              appId: app.id,
              args: args || {},
              user,
              language: platform?.defaultLanguage || 'en'
            });
            return toolSuccessResult(text || '');
          } catch (err) {
            logger.warn('MCP gateway app invocation failed', {
              component: 'McpServerService',
              appId: app.id,
              user: user.id,
              error: err.message
            });
            return toolErrorResult(err.message || 'app invocation failed');
          }
        }
      );
    }
  }

  // ---- Workflows (exposed as MCP tools) -----------------------------------
  if (expose.workflows && tokenScopes.includes(MCP_SCOPES.WORKFLOWS_RUN)) {
    const { data: workflows = [] } = configCache.getWorkflows(true);
    for (const wf of workflows) {
      if (!isWorkflowAllowed(wf, user, expose)) continue;
      const paramsSchema = buildWorkflowMcpParams(wf);
      server.registerTool(
        buildWorkflowToolName(wf.id),
        {
          description:
            extractText(wf.chatIntegration?.toolDescription) ||
            extractText(wf.description) ||
            `iHub workflow: ${wf.id}`,
          ...jsonSchemaToInputSchema(paramsSchema)
        },
        async args => {
          // Re-check scope + permission at call time so a token that loses the
          // scope, or a user removed from the workflow's groups, between list
          // and call can't still run it (mirrors the tools handler above).
          if (!tokenScopes.includes(MCP_SCOPES.WORKFLOWS_RUN)) {
            return toolErrorResult('insufficient_scope: mcp:workflows:run required');
          }
          if (!isWorkflowAllowed(wf, user, expose)) {
            return toolErrorResult('access_denied: workflow not permitted for this caller');
          }
          try {
            const result = await runTool(`workflow_${wf.id}`, args || {});
            return toolSuccessResult(result);
          } catch (err) {
            logger.warn('MCP gateway workflow run failed', {
              component: 'McpServerService',
              workflowId: wf.id,
              user: user.id,
              error: err.message
            });
            return toolErrorResult(err.message || 'workflow execution failed');
          }
        }
      );
    }
  }

  // ---- Resources (sources + skills as MCP resources) ----------------------
  if (expose.resources && tokenScopes.includes(MCP_SCOPES.RESOURCES_READ)) {
    const resources = await listMcpResources({ user, platform, expose });
    for (const r of resources) {
      // registerResource binds a single URI to a read callback. The SDK's
      // `resources/list` is served from the union of registered entries.
      server.registerResource(
        r.name,
        r.uri,
        { description: r.description, mimeType: r.mimeType },
        async uriObj => {
          // Re-check scope at call time for consistency with the tool/app/
          // workflow handlers. resourceAdapter additionally re-validates the
          // caller's visibility of the underlying source/skill at read time.
          if (!tokenScopes.includes(MCP_SCOPES.RESOURCES_READ)) {
            throw new Error('insufficient_scope: mcp:resources:read required');
          }
          try {
            return await readMcpResource(uriObj.href || String(uriObj), {
              user,
              platform,
              language: platform?.defaultLanguage || 'en'
            });
          } catch (err) {
            logger.warn('MCP gateway resource read failed', {
              component: 'McpServerService',
              uri: r.uri,
              user: user.id,
              error: err.message
            });
            // MCP resource reads don't have an isError sentinel; throwing
            // surfaces as a JSON-RPC error to the client.
            throw err;
          }
        }
      );
    }
  }

  // ---- Audit hook on every dispatch ---------------------------------------
  try {
    server.server.onRequest = async (request, extra) => {
      actionTracker.trackToolCallStart?.(null, {
        toolName: `mcp:${request.method}`,
        toolInput: { user: user.id, scopes: tokenScopes }
      });
      return extra?.next?.();
    };
  } catch {
    /* SDK may not expose onRequest in all versions */
  }

  return server;
}

function toolSuccessResult(payload) {
  if (typeof payload === 'string') {
    return { content: [{ type: 'text', text: payload }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function toolErrorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.en || value.de || Object.values(value)[0] || '';
  }
  return String(value);
}

function buildWorkflowMcpParams(wf) {
  const properties = {
    input: { type: 'string', description: 'Primary input for the workflow' }
  };
  const required = ['input'];
  const startNode = (wf.nodes || []).find(n => n.type === 'start');
  for (const v of startNode?.config?.inputVariables || []) {
    if (typeof v === 'string') {
      if (v !== 'input') properties[v] = { type: 'string', description: v };
      continue;
    }
    if (!v?.name || v.name === 'input') continue;
    if (v.type === 'file' || v.type === 'image') continue;
    properties[v.name] = {
      type: ['number', 'integer', 'boolean'].includes(v.type) ? v.type : 'string',
      description:
        typeof v.description === 'string' ? v.description : extractText(v.description) || v.name
    };
    if (v.required) required.push(v.name);
  }
  return { type: 'object', properties, required };
}

// Expose zod re-export for tests that want to introspect the schema package.
export { z };
