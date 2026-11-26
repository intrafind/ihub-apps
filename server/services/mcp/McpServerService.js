// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  fromJsonSchema,
  inputRequired,
  inputResponse
} from '@modelcontextprotocol/server';
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
import { directCallNeedsApproval, resolveSideEffect } from '../../utils/toolApproval.js';
import { APPROVAL_ERROR_CODES } from '../../../shared/toolApproval.js';
import { argumentsDigest, gatewayRequestStateCodec } from './gatewayRequestState.js';
import { attachGatewaySkills } from './gatewaySkills.js';
import { attachGatewayTasks, clientAcceptsTasks, startGatewayTask } from './gatewayTasks.js';

/**
 * Whether a tool exposed through the gateway needs a person's approval
 * (#2945). The gateway asks the person through the MCP client (elicitation,
 * see {@link gatewayApproval}); a client that cannot ask gets the call refused
 * with `APPROVAL_REQUIRED_NO_USER` instead.
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

/** Keywords whose value maps names (not keywords) to subschemas. */
const SCHEMA_NAME_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas'
]);

/**
 * The JSON Schema a tool advertises: the tool's own parameters, with every
 * localized `description` (`{ en, de }`) reduced to one string, as clients
 * expect, and an object root.
 *
 * @param {Object} jsonSchema - The tool's parameters
 * @returns {Object}
 */
export function toAdvertisedJsonSchema(jsonSchema) {
  const clean = node => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description') {
        const text = localizedToString(value);
        if (text) out.description = text;
      } else if (SCHEMA_NAME_MAPS.has(key) && value && typeof value === 'object') {
        out[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [name, clean(child)])
        );
      } else {
        out[key] = clean(value);
      }
    }
    return out;
  };
  const root = clean(jsonSchema && typeof jsonSchema === 'object' ? jsonSchema : {});
  const properties =
    root.properties && typeof root.properties === 'object' && !Array.isArray(root.properties)
      ? root.properties
      : {};
  return { ...root, type: 'object', properties };
}

/**
 * The config fragment `registerTool(name, config, cb)` takes for a tool's
 * input: the tool's JSON Schema, advertised as it is and validated by the SDK
 * (`fromJsonSchema`).
 *
 * Every tool gets an `inputSchema`, a paramless one too: the SDK passes a tool
 * registered without one the request context as its only argument.
 *
 * @param {Object} jsonSchema
 * @returns {{inputSchema: Object}}
 */
export function jsonSchemaToInputSchema(jsonSchema) {
  return { inputSchema: fromJsonSchema(toAdvertisedJsonSchema(jsonSchema)) };
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

/** Key of the approval question in a call's `inputRequests` / `inputResponses`. */
const APPROVAL_INPUT_KEY = 'approval';

/** What the person is asked to fill in: one checkbox. */
const APPROVAL_REQUESTED_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    approve: {
      type: 'boolean',
      title: 'Approve',
      description: 'Run this action now'
    }
  },
  required: ['approve']
});

/** Most characters of the arguments shown in the approval question. */
const APPROVAL_ARGS_PREVIEW = 600;

/**
 * Whether the client of this request can ask its user a form question
 * (elicitation): declared per request on 2026-07-28, at `initialize` on a
 * 2025-era session. A bare `elicitation: {}` is form support (the meaning
 * before modes existed).
 *
 * @param {McpServer} server
 * @param {Object} ctx - The SDK's request context
 * @returns {boolean}
 */
export function clientCanElicit(server, ctx) {
  const capabilities =
    ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY] ??
    server.server.getClientCapabilities?.();
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== 'object') return false;
  return Object.keys(elicitation).length === 0 || Boolean(elicitation.form);
}

/**
 * The approval of a gated tool call, asked of the person through the MCP
 * client (elicitation, #2945).
 *
 * The first round answers `input_required` with the question and a signed
 * `requestState` naming the caller, the tool and a digest of the arguments
 * (`gatewayRequestState.js`); the client asks its user and retries the call
 * with the answer. Only an answer that comes back with that state counts, so
 * a client cannot approve a call by sending an answer nobody was asked for, nor
 * reuse an approval for other arguments. A client that cannot ask anyone gets
 * the call refused with `APPROVAL_REQUIRED_NO_USER`, as before.
 *
 * @param {Object} params
 * @param {McpServer} params.server
 * @param {Object} params.ctx - The SDK's request context
 * @param {Object} params.tool
 * @param {Object} params.args
 * @param {Object} params.user
 * @returns {Promise<{approved: true}|{result: Object}>} Approved, or what to answer instead
 */
export async function gatewayApproval({ server, ctx, tool, args, user }) {
  const binding = {
    kind: 'approval',
    tool: tool.id,
    user: user.id,
    args: argumentsDigest(args)
  };
  const state = ctx.mcpReq.requestState?.();
  const answered =
    state?.kind === binding.kind &&
    state.tool === binding.tool &&
    state.user === binding.user &&
    state.args === binding.args;
  if (answered) {
    const answer = inputResponse(ctx.mcpReq.inputResponses, APPROVAL_INPUT_KEY);
    if (answer.kind === 'elicit') {
      if (answer.action === 'accept' && answer.content?.approve === true) {
        logger.info('MCP gateway call approved by the user', {
          component: 'McpServerService',
          toolId: tool.id,
          userId: user.id
        });
        return { approved: true };
      }
      return {
        result: toolErrorResult(
          `${APPROVAL_ERROR_CODES.USER_REJECTED}: the user did not approve this action; it was not run`
        )
      };
    }
  }
  if (!clientCanElicit(server, ctx)) {
    return {
      result: toolErrorResult(
        `${APPROVAL_ERROR_CODES.APPROVAL_REQUIRED_NO_USER}: this tool needs a person's approval and this MCP client cannot ask for it`
      )
    };
  }
  let preview = JSON.stringify(args ?? {});
  if (preview.length > APPROVAL_ARGS_PREVIEW) {
    preview = `${preview.slice(0, APPROVAL_ARGS_PREVIEW)}…`;
  }
  const name = tool._integration?.name || tool._integration?.instanceId;
  const integration = name ? ` (${name})` : '';
  return {
    result: inputRequired({
      inputRequests: {
        [APPROVAL_INPUT_KEY]: inputRequired.elicit({
          message: `iHub needs your approval to run "${tool.id}"${integration} with ${preview}`,
          requestedSchema: APPROVAL_REQUESTED_SCHEMA
        })
      },
      requestState: await gatewayRequestStateCodec().mint(binding)
    })
  };
}

/**
 * MCP tool annotations of an installed integration's action, from the side
 * effect iHub resolves for it (`utils/toolApproval.js`). Hints only: a client
 * may run read-only calls in parallel or repeat them after a dropped
 * connection.
 *
 * @param {Object} tool
 * @returns {Object|undefined}
 */
function integrationToolAnnotations(tool) {
  const installation = installedIntegrationById(tool._integration?.instanceId);
  const { sideEffect } = resolveSideEffect(tool, installation);
  if (sideEffect === 'read') return { readOnlyHint: true };
  if (sideEffect === 'write') return { readOnlyHint: false, destructiveHint: false };
  if (sideEffect === 'destructive') return { readOnlyHint: false, destructiveHint: true };
  return undefined;
}

/**
 * Build the per-request MCP server bound to a specific authenticated user.
 *
 * @param {object} ctx - Build context.
 * @param {object} ctx.user - Enhanced user object (req.user after
 *   enhanceUserWithPermissions). MUST NOT be anonymous; mcpAuth enforces this.
 * @param {object} ctx.platform - Platform config (configCache.getPlatform()).
 * @param {'legacy'|'modern'} [ctx.era='legacy'] - The protocol era the server
 *   serves: `modern` for 2026-07-28 requests, `legacy` for 2025-era ones
 * @returns {Promise<McpServer>}
 */
export async function buildMcpServer({ user, platform, era = 'legacy' }) {
  if (!user || user.id === 'anonymous') {
    // Defence in depth — mcpAuth should already have rejected anonymous.
    throw new Error('MCP gateway requires an authenticated user');
  }

  const gateway = platform?.mcpServer || {};
  const expose = gateway.expose || { tools: true, apps: true, workflows: true, resources: false };
  const tokenScopes = user.scopes || [];

  const server = new McpServer(
    { name: 'ihub-apps', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      // The state of an approval round (gatewayRequestState.js); a state that
      // fails the check is refused before a tool handler runs.
      requestState: { verify: gatewayRequestStateCodec().verify }
    }
  );

  // One structured log line per tool call (the audit trail of the gateway;
  // the ledger records the tool runs of the invoked apps).
  const registerTool = (name, config, handler) =>
    server.registerTool(name, config, async (args, ctx) => {
      logger.info('MCP gateway tool call', {
        component: 'McpServer',
        tool: name,
        userId: user.id,
        era
      });
      return handler(args, ctx);
    });

  // Long runs (apps, workflows) answer with a task handle to a client that
  // takes one (MCP Tasks extension, 2026-07-28); everyone else waits.
  const runMaybeAsTask = (name, ctx, run) =>
    era === 'modern' && clientAcceptsTasks(ctx)
      ? startGatewayTask({ user, toolName: name, run })
      : run(undefined);

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
      const annotations = integrationToolAnnotations(tool);
      registerTool(
        tool.id,
        {
          description: typeof tool.description === 'string' ? tool.description : '',
          ...jsonSchemaToInputSchema(tool.parameters),
          ...(annotations ? { annotations } : {})
        },
        async (args, ctx) => {
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
          // A gated tool waits for a person's approval, asked through the client.
          if (gatewayCallNeedsApproval(tool, configCache.getPlatform?.() || platform)) {
            const approval = await gatewayApproval({ server, ctx, tool, args, user });
            if (!approval.approved) return approval.result;
          }
          try {
            // Inject the authenticated caller's identity + a tracking chatId.
            // Integration tools (iFinder, Entra, Jira, ...) run *as the user* and
            // reject calls without an authenticated `user`/`chatId` in their
            // params. `withTrustedToolContext` strips those fields from the
            // arguments and sets them last, so arguments can never spoof them.
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
      const toolName = buildAppToolName(app.id);
      registerTool(
        toolName,
        {
          description:
            extractText(app.description) || extractText(app.name) || `iHub app: ${app.id}`,
          ...jsonSchemaToInputSchema(buildAppInputSchema(app))
        },
        async (args, ctx) => {
          // Re-check scope + permission at call time so a token that loses the
          // scope, or a user removed from the app's groups, between list and
          // call can't still invoke it (mirrors the tools handler above).
          if (!tokenScopes.includes(MCP_SCOPES.APPS_INVOKE)) {
            return toolErrorResult('insufficient_scope: mcp:apps:invoke required');
          }
          if (!isAppAllowed(app, user, expose)) {
            return toolErrorResult('access_denied: app not permitted for this caller');
          }
          return runMaybeAsTask(toolName, ctx, async abortSignal => {
            try {
              let outputs = null;
              const text = await invokeAppNonStreaming({
                appId: app.id,
                args: args || {},
                user,
                language: platform?.defaultLanguage || 'en',
                onOutputs: produced => {
                  outputs = produced;
                },
                ...(abortSignal ? { abortSignal } : {})
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
          });
        }
      );
    }
  }

  // ---- Workflows (exposed as MCP tools) -----------------------------------
  if (expose.workflows && tokenScopes.includes(MCP_SCOPES.WORKFLOWS_RUN)) {
    const { data: workflows = [] } = configCache.getWorkflows(true);
    for (const wf of workflows) {
      if (!isWorkflowAllowed(wf, user, expose)) continue;
      const toolName = buildWorkflowToolName(wf.id);
      const paramsSchema = buildWorkflowMcpParams(wf);
      registerTool(
        toolName,
        {
          description:
            extractText(wf.chatIntegration?.toolDescription) ||
            extractText(wf.description) ||
            `iHub workflow: ${wf.id}`,
          ...jsonSchemaToInputSchema(paramsSchema)
        },
        async (args, ctx) => {
          // Re-check scope + permission at call time so a token that loses the
          // scope, or a user removed from the workflow's groups, between list
          // and call can't still run it (mirrors the tools handler above).
          if (!tokenScopes.includes(MCP_SCOPES.WORKFLOWS_RUN)) {
            return toolErrorResult('insufficient_scope: mcp:workflows:run required');
          }
          if (!isWorkflowAllowed(wf, user, expose)) {
            return toolErrorResult('access_denied: workflow not permitted for this caller');
          }
          // A cancelled task stops recording, but the workflow engine runs its
          // current execution to the end: cancellation is cooperative.
          return runMaybeAsTask(toolName, ctx, async () => {
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
                ? await recordTextOutput({
                    text: answer.text,
                    model: { id: `workflow:${wf.id}` },
                    user
                  })
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
          });
        }
      );
    }
  }

  // ---- Resources (projects + skills as MCP resources) ---------------------
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
    // The same skills over the MCP Skills extension (`skills/list`,
    // `skill://` files with digests), for clients that load skills.
    attachGatewaySkills(server, { user });
  }

  // ---- Tasks extension (2026-07-28) ----------------------------------------
  // `tasks/get` and friends exist on 2026-07-28 only; a 2025-era session has
  // its own, different task vocabulary, which the gateway does not serve.
  if (era === 'modern') attachGatewayTasks(server, { user });

  return server;
}

function toolSuccessResult(payload) {
  if (typeof payload === 'string') {
    return { content: [{ type: 'text', text: payload }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** `content_hash` of a stamped generated image. */
function imageHashOf(image) {
  return { alg: 'sha-256', normalization: 'none', value: image.provenance.contentHash };
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
    // `_meta.provenance` names the output (EU AI Act Art. 50(2), #3328); the
    // bytes stay exactly as the provider sent them.
    content.push({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType,
      ...(image.provenance?.outputId
        ? {
            _meta: mcpMeta({
              output_id: image.provenance.outputId,
              content_hash: imageHashOf(image)
            })
          }
        : {})
    });
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
