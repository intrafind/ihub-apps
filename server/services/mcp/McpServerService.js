import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import configCache from '../../configCache.js';
import { loadConfiguredTools, runTool } from '../../toolLoader.js';
import { invokeAppNonStreaming } from './appInvoker.js';
import { listMcpResources, readMcpResource } from './resourceAdapter.js';
import { getVisibleToolIds, toolVisibleInSet } from './permissions.js';
import { MCP_SCOPES } from './scopes.js';
import logger from '../../utils/logger.js';
import { getLocalizedString } from '../../utils/localize.js';

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
 * Coerce a possibly-localized value (`string` or `{ en, de, ... }`) to a plain
 * string for use as a JSON Schema `description`. Nested tool parameters may
 * still carry localized descriptions that `loadConfiguredTools` did not flatten.
 */
function localizedToString(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.en || Object.values(value).find(v => typeof v === 'string');
  }
  return undefined;
}

/**
 * Convert a single JSON Schema node into a Zod type. Handles the subset of
 * JSON Schema that iHub app/workflow/tool definitions use (object, string,
 * number, integer, boolean, array, enum, nullable). Anything unrecognized
 * falls back to `z.any()` so a call is never rejected for a construct we can't
 * model.
 */
function jsonSchemaNodeToZod(node) {
  if (!node || typeof node !== 'object') return z.any();

  // String enums map cleanly onto z.enum; mixed/other enums fall through.
  if (
    Array.isArray(node.enum) &&
    node.enum.length > 0 &&
    node.enum.every(v => typeof v === 'string')
  ) {
    const enumType = z.enum(node.enum);
    const enumDesc = localizedToString(node.description);
    return enumDesc ? enumType.describe(enumDesc) : enumType;
  }

  const rawType = Array.isArray(node.type) ? node.type.find(t => t !== 'null') : node.type;
  let zodType;
  switch (rawType) {
    case 'string':
      zodType = z.string();
      break;
    case 'number':
    case 'integer':
      zodType = z.number();
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    case 'array':
      zodType = z.array(node.items ? jsonSchemaNodeToZod(node.items) : z.any());
      break;
    case 'object': {
      const props = node.properties || {};
      // Free-form object (no declared properties, e.g. `additionalProperties`
      // or an open payload). `z.object({})` strips every key and would silently
      // drop the caller's whole object — the same empty-schema data loss this
      // module exists to fix. `z.record` preserves arbitrary keys instead.
      if (Object.keys(props).length === 0) {
        zodType = z.record(z.any());
        break;
      }
      const shape = {};
      const req = Array.isArray(node.required) ? node.required : [];
      for (const [key, child] of Object.entries(props)) {
        let childType = jsonSchemaNodeToZod(child);
        if (!req.includes(key)) childType = childType.optional();
        shape[key] = childType;
      }
      zodType = z.object(shape);
      break;
    }
    default:
      zodType = z.any();
  }

  if (Array.isArray(node.type) && node.type.includes('null')) zodType = zodType.nullable();
  const desc = localizedToString(node.description);
  if (desc) zodType = zodType.describe(desc);
  return zodType;
}

/**
 * Convert a top-level JSON Schema object (`{ type:'object', properties,
 * required }`) into a Zod **raw shape** (`{ [prop]: ZodType }`).
 */
function jsonSchemaToZodShape(jsonSchema) {
  const shape = {};
  if (!jsonSchema || typeof jsonSchema !== 'object' || !jsonSchema.properties) {
    return shape;
  }
  const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
  for (const [key, node] of Object.entries(jsonSchema.properties)) {
    let childType = jsonSchemaNodeToZod(node);
    if (!required.includes(key)) childType = childType.optional();
    shape[key] = childType;
  }
  return shape;
}

/**
 * Build the config fragment that MCP's `registerTool(name, config, cb)` expects
 * for a tool's input.
 *
 * SDK 1.x reads `config.inputSchema` and requires it to be a **Zod raw shape**
 * (or Zod object) — it does NOT accept raw JSON Schema, and silently ignores any
 * other key (e.g. `jsonSchema`), which makes the tool advertise an empty
 * `{ properties: {} }` schema so clients strip every argument. We therefore
 * convert our JSON Schema to a Zod raw shape here. When there are no properties
 * we omit `inputSchema` entirely, preserving the SDK's no-validation path for
 * genuinely paramless tools.
 */
export function jsonSchemaToInputSchema(jsonSchema) {
  const shape = jsonSchemaToZodShape(jsonSchema);
  if (Object.keys(shape).length === 0) {
    return {};
  }
  return { inputSchema: shape };
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
export function buildAppInputSchema(app) {
  const properties = {
    message: {
      type: 'string',
      description: 'User message / prompt sent to the iHub app'
    }
  };
  const required = ['message'];
  // Let callers pick a model unless the app pins one. When the app restricts
  // models, advertise the choices as an enum; otherwise accept any model id.
  // RequestBuilder falls back to the app's preferred model when the requested
  // one is missing or incompatible, so an unknown id can't error. Note this
  // enforces app-level `allowedModels`, not per-user `permissions.models` —
  // the same as the chat route, which doesn't gate execution on model
  // permissions either (see appInvoker.js).
  if (!app.disallowModelSelection) {
    const modelProp = {
      type: 'string',
      description: "Optional model id to run this app with. Defaults to the app's preferred model."
    };
    if (Array.isArray(app.allowedModels) && app.allowedModels.length > 0) {
      modelProp.enum = app.allowedModels;
    }
    properties.modelId = modelProp;
  }
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

  // Local registration counters — used below to install empty-list fallback
  // handlers without reaching into SDK-private fields.
  let registeredToolCount = 0;
  let registeredResourceCount = 0;
  const registerTool = (...args) => {
    server.registerTool(...args);
    registeredToolCount += 1;
  };
  const registerResource = (...args) => {
    server.registerResource(...args);
    registeredResourceCount += 1;
  };

  // ---- Tools (iHub-native, local-only) ------------------------------------
  // loadConfiguredTools excludes outbound MCP-discovered tools so the gateway
  // never re-proxies another server's tools to inbound callers.
  if (expose.tools && tokenScopes.includes(MCP_SCOPES.TOOLS_READ)) {
    const visibleToolIds = await getVisibleToolIds(user, platform);
    const tools = await loadConfiguredTools(platform?.defaultLanguage || 'en');
    for (const tool of tools) {
      if (!isToolAllowed(tool, expose, visibleToolIds)) continue;
      registerTool(
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
            // Inject the authenticated caller's identity + a tracking chatId.
            // Integration tools (iFinder, Entra, Jira, ...) run *as the user* and
            // reject calls without an authenticated `user`/`chatId` in their
            // params. MCP args are schema-validated first, so they can never
            // spoof these fields — we set them last regardless.
            const result = await runTool(tool.id, {
              ...(args || {}),
              user,
              chatId: `mcp-${Date.now()}`
            });
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
      registerTool(
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
      registerTool(
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
      registerResource(
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

  // ---- Empty-registry fallbacks --------------------------------------------
  // The SDK only installs its tools/list and resources/list handlers when at
  // least one tool/resource was registered; with zero registrations a client
  // gets JSON-RPC -32601 "Method not found", which MCP clients (Claude,
  // Cursor) surface as a connection error. Since the registry is fixed after
  // build, install explicit empty-list handlers instead.
  if (registeredToolCount === 0) {
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  }
  if (registeredResourceCount === 0) {
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  }

  // ---- Audit hook on every dispatch ---------------------------------------
  // A structured log line per gateway request (the former SSE-tracker call had
  // no stream to reach; the ledger records tool runs of the invoked apps).
  try {
    server.server.onRequest = async (request, extra) => {
      logger.info('MCP gateway request', {
        component: 'McpServer',
        method: request?.method,
        userId: user.id,
        scopes: tokenScopes
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
  if (typeof value === 'object') return getLocalizedString(value, 'en');
  return String(value);
}

export function buildWorkflowMcpParams(wf) {
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
