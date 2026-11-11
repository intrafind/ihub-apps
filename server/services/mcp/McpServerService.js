// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import configCache from '../../configCache.js';
import { runTool } from '../tools/runTool.js';
import {
  filterDirectoryToolsForUser,
  mayUseDirectory
} from '../peopleDirectory/PeopleDirectoryService.js';
import { withTrustedToolContext } from '../../utils/toolCallContext.js';
import { invokeAppNonStreaming } from './appInvoker.js';
import { recordTextOutput } from '../provenance/turnProvenance.js';
import { mcpMeta } from '../provenance/httpProvenance.js';
import { listMcpResources, readMcpResource } from './resourceAdapter.js';
import { MCP_SCOPES } from './scopes.js';
import logger from '../../utils/logger.js';
import { getLocalizedString } from '../../utils/localize.js';
import { workflowAnswerParts } from '../workflow/answerParts.js';
import { installedIntegrationById } from '../integrations/installedRefs.js';
import { directCallNeedsApproval } from '../../utils/toolApproval.js';
import { APPROVAL_ERROR_CODES } from '../../../shared/toolApproval.js';

/**
 * Whether a tool exposed through the gateway needs a person's approval
 * (#2945). The gateway has nobody to ask: such a call is refused with
 * `APPROVAL_REQUIRED_NO_USER` instead of running.
 *
 * @param {Object} tool
 * @param {Object} platform
 * @returns {boolean}
 */
export function gatewayCallNeedsApproval(tool, platform) {
  return directCallNeedsApproval(tool, platform, { getInstallation: installedIntegrationById });
}

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
 * still carry localized descriptions.
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

/**
 * The optional file input of an app or workflow tool: files the app should
 * work with, taken into the invocation's chat like an upload.
 */
const FILES_INPUT_SCHEMA = Object.freeze({
  type: 'array',
  description:
    'Optional files for the app to work with. Each file needs a name and either `data` (base64) or `text`.',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'File name, e.g. report.pdf' },
      mimeType: { type: 'string', description: 'Media type, e.g. application/pdf' },
      data: { type: 'string', description: 'File content, base64 encoded' },
      text: { type: 'string', description: 'File content as text (instead of data)' }
    },
    required: ['name']
  }
});

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
  properties.files = FILES_INPUT_SCHEMA;
  // Let callers pick a model unless the app pins one. When the app restricts
  // models, advertise the choices as an enum; otherwise accept any model id.
  // RequestBuilder falls back to the app's preferred model when the requested
  // one is missing or incompatible, so an unknown id can't error. This enum
  // only reflects app-level `allowedModels` — it does not narrow further for
  // the calling user's `permissions.models`, so a model listed here can still
  // be refused with `modelAccessDeniedForUser` at call time if the user's
  // group doesn't permit it (see appInvoker.js).
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

const IHUB_DEFINITION_ID = 'com.intrafind/ihub';

/**
 * Whether the gateway offers an installed integration's action as an MCP tool.
 * The integrations are the tools (#3275): every action of an enabled
 * installation the caller's groups grant (`permissions.integrations`, checked
 * by `filterIntegrationToolsForUser` and again at call time) is offered, with
 * the approval policy of the action (`gatewayCallNeedsApproval`).
 *
 * Four kinds stay out:
 * - the actions of an outbound MCP server (`_mcp`) and the skills of a remote
 *   A2A agent (`_a2a`, #2546): iHub is their client, not a proxy that hands
 *   the credentials of those servers and agents to inbound callers;
 * - the admin LDAP browser (`_ldapBrowser`): it returns raw directory entries
 *   and stays in iHub's own chat, where its calls are audited per admin;
 * - iHub's own chat tools (`com.intrafind/ihub`: `ask_user`, the scheduled-task
 *   tools): they work through the chat loop (pausing for an answer, the
 *   scheduled-task gate), which a gateway call does not have.
 *
 * @param {Object} tool - a tool of an installed integration
 * @param {Object} expose - the gateway's `expose` switches
 * @returns {boolean}
 */
export function isToolAllowed(tool, expose) {
  if (!expose.tools) return false;
  if (!tool._integration) return false;
  if (tool._mcp || tool._a2a || tool._ldapBrowser) return false;
  if (tool._integration.definition === IHUB_DEFINITION_ID) return false;
  return true;
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

  // ---- Tools (the actions of the installed integrations) ------------------
  if (expose.tools && tokenScopes.includes(MCP_SCOPES.TOOLS_READ)) {
    const language = platform?.defaultLanguage || 'en';
    const {
      discoverIntegrationTools,
      filterIntegrationToolsForUser,
      getIntegrationToolsForApp,
      userMayUse
    } = await import('../integrations/integrationTools.js');
    let tools = filterDirectoryToolsForUser(
      filterIntegrationToolsForUser(
        (await discoverIntegrationTools(language)).filter(tool => isToolAllowed(tool, expose)),
        user
      ),
      user
    );
    // A machine client (client credentials, static key) holds no group grants:
    // its permissions are `integrations: ['*']`, bounded by the apps it may
    // use. An integration reaches it only through the binding of such an app.
    // A user-delegated token (authorization code, personal API key) whose
    // client names `allowedApps` is bounded the same way, on top of the
    // user's own grants.
    const clientApps = user.clientAllowedApps;
    const clientNarrowsApps =
      Array.isArray(clientApps) && clientApps.length > 0 && !clientApps.includes('*');
    let reachable = null;
    if (user.isOAuthClient || clientNarrowsApps) {
      const { data: apps = [] } = await configCache.getAppsForUser(user, platform);
      reachable = new Set(
        apps.flatMap(app => getIntegrationToolsForApp(app, tools, { user }).map(tool => tool.id))
      );
      tools = tools.filter(tool => reachable.has(tool.id));
    }
    for (const tool of tools) {
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
          // Re-check the grant at call time so a permission change between
          // list and call can't be exploited.
          const instance = installedIntegrationById(tool._integration.instanceId);
          if (
            !instance ||
            instance.enabled === false ||
            !userMayUse(instance, user) ||
            (reachable && !reachable.has(tool.id)) ||
            (tool._peopleDirectory && !mayUseDirectory(user, tool._peopleDirectory.id))
          ) {
            return toolErrorResult('access_denied: tool not permitted for this caller');
          }
          // A gated tool waits for a person's approval; nobody here can give it.
          if (gatewayCallNeedsApproval(tool, configCache.getPlatform?.() || platform)) {
            return toolErrorResult(
              `${APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER}: this tool needs a person's approval and cannot run through the MCP gateway`
            );
          }
          try {
            // Inject the authenticated caller's identity + a tracking chatId.
            // Integration tools (iFinder, Entra, Jira, ...) run *as the user* and
            // reject calls without an authenticated `user`/`chatId` in their
            // params. MCP args are schema-validated first, so they can never
            // spoof these fields — we set them last regardless.
            const result = await runTool(
              tool.id,
              withTrustedToolContext(args, { user, chatId: `mcp-${Date.now()}` })
            );
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
            let outputs = null;
            const text = await invokeAppNonStreaming({
              appId: app.id,
              args: args || {},
              user,
              language: platform?.defaultLanguage || 'en',
              onOutputs: produced => {
                outputs = produced;
              }
            });
            return appToolResult(text || '', outputs);
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
            // The workflow runs as the authenticated caller (its per-user
            // OAuth MCP calls use the caller's own token); the arguments can
            // never name another user.
            const { input: workflowArgs, context } = await workflowFileInput(args, user);
            const result = await runTool(
              `workflow_${wf.id}`,
              withTrustedToolContext(workflowArgs, {
                user,
                chatId: context.chatId || `mcp-${Date.now()}`,
                ...(context.fileData ? { _fileData: context.fileData } : {})
              })
            );
            const answer = workflowAnswerParts(result);
            const provenance = answer.ok
              ? await recordTextOutput({ text: answer.text, model: { id: `workflow:${wf.id}` } })
              : null;
            return workflowToolResult(result, provenance);
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

/**
 * The MCP result of an app run: its answer as a text block, then the files and
 * pictures the app produced as standard content blocks — an embedded resource
 * (`{ type: 'resource', resource: { uri, mimeType, blob } }`) per file and an
 * image block (`{ type: 'image', data, mimeType }`) per picture, the bytes
 * base64 as the protocol says.
 *
 * @param {string} text - The app's answer
 * @param {{generatedFiles?: Array<Object>, images?: Array<Object>, provenance?: Object}|null} [outputs]
 * @returns {Object} An MCP tool result
 */
export function appToolResult(text, outputs = null) {
  const content = [{ type: 'text', text }];
  for (const file of outputs?.generatedFiles || []) {
    if (!file?.data) continue;
    content.push({
      type: 'resource',
      resource: {
        uri: `ihub://generated/${encodeURIComponent(file.id || 'file')}/${encodeURIComponent(file.name || 'file')}`,
        mimeType: file.mimeType,
        blob: file.data
      }
    });
  }
  for (const image of outputs?.images || []) {
    if (!image?.data || !image?.mimeType) continue;
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  // EU AI Act Art. 50(2): machine-readable provenance of the answer.
  return { content, ...(outputs?.provenance ? { _meta: mcpMeta(outputs.provenance) } : {}) };
}

/**
 * The `files` input of a workflow tool call: the arguments without it, and —
 * when files came — the chat they were taken into and their `fileData`, which
 * the workflow receives as its uploaded files.
 *
 * @param {Object} args - The tool's arguments
 * @param {Object} user - The authenticated caller
 * @returns {Promise<{input: Object, context: {chatId?: string, fileData?: Array<Object>}}>}
 * @throws {InboundFileError} A file that cannot be taken
 */
async function workflowFileInput(args, user) {
  if (!Array.isArray(args?.files)) return { input: args, context: {} };
  const { files, ...input } = args;
  const { normalizeMcpFiles, ingestInboundFiles, inboundChatId } =
    await import('./inboundFiles.js');
  const normalized = normalizeMcpFiles(files);
  if (normalized.length === 0) return { input, context: {} };
  const chatId = inboundChatId(`mcp-${Date.now()}`);
  const { fileData } = await ingestInboundFiles({
    files: normalized,
    chatId,
    user,
    origin: 'mcp',
    message: { role: 'user', content: String(input.input ?? '') }
  });
  return { input, context: { chatId, fileData } };
}

/**
 * The MCP result of a workflow run: its answer and nothing else. Text comes as
 * text; JSON comes as `structuredContent` (`{ output: <the JSON> }`), with the
 * same JSON written out as text for a client that reads only text. A run that
 * did not finish with an answer is an error.
 *
 * Unlike an app run ({@link appToolResult}), a workflow run returns no generated
 * files or pictures, on purpose: a workflow's result is its `output` (text or
 * JSON) and nothing in the workflow engine collects files. The tool node stores a
 * tool's result in the workflow state as data, the prompt node's loop has no
 * file-lifting seam, and `workflowRunner` resolves with `{ status, output,
 * executionId }` only. A file a workflow node produced therefore cannot be handed
 * to the caller here; inventing a side channel for it would hide the gap. Files a
 * caller *sends* to a workflow do work (`files`, see `workflowFileInput`).
 *
 * @param {Object|string} result - What `workflowRunner` resolved with
 * @param {Object|null} [provenance] - Provenance object of the answer, put in `_meta.provenance`
 * @returns {Object} An MCP tool result
 */
export function workflowToolResult(result, provenance = null) {
  const answer = workflowAnswerParts(result);
  if (!answer.ok) return toolErrorResult(answer.error);
  return {
    content: [{ type: 'text', text: answer.text }],
    ...(provenance ? { _meta: mcpMeta(provenance) } : {}),
    ...(answer.json ? { structuredContent: answer.json } : {})
  };
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
  properties.files = FILES_INPUT_SCHEMA;
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
