// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * App Tools Gateway
 *
 * The shared internal interface for invoking iHub Apps programmatically —
 * server-side, without going through the REST API. Every caller that wants
 * another app to answer a message routes through here:
 *
 *  - **Chat apps** (`app.apps: [...]`): `getToolsForApp()` surfaces the listed
 *    apps as synthetic `app__<appId>` tools; the tool runner
 *    (`services/run/ToolRunner.js`) dispatches them to
 *    `invokeAppTool()` (the "concierge" pattern — a bot delegating to
 *    specialist bots).
 *  - **Agent workflow nodes** (`node.config.apps`): PromptNodeExecutor
 *    registers the same synthetic tools and calls `invokeAppTool()` directly.
 *
 * Each tool's parameters are derived from `app.variables` and its description
 * is the localized app description. A call builds a run spec and runs the app
 * on the run service (`services/run/RunService.js`) with a headless host: the
 * standard chat preparation (model resolution, system prompt, tools), the
 * agent loop, and nobody who can answer an approval or a question.
 *
 * Guard rails:
 *  - `features.appAsTool` must be enabled.
 *  - The principal must carry resolved `permissions` and may only invoke apps
 *    it is allowed to access — the same check `chatAuthRequired` applies on
 *    the HTTP route. A principal without resolved permissions (a bare object,
 *    or none at all) is refused: nothing runs on a guess.
 *  - App→App nesting is disallowed: the callee runs one level deep with
 *    `isInvokedViaAppAsTool: true`, which suppresses further `app__*` tools
 *    (see `getToolsForApp`) and is rejected outright by `invokeAppTool()`.
 */

import configCache from '../../configCache.js';
import { areAppFeaturesEnabled, isFeatureEnabled } from '../../featureRegistry.js';
import { areAppIntegrationsEnabled } from '../../integrationRegistry.js';
import logger from '../../utils/logger.js';
import { getLocalizedString } from '../../utils/localize.js';
import { canUserAccessResource } from '../../utils/authorization.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { appRunSpec, runService, RUN_REFUSAL_CODES } from '../run/RunService.js';
import { HeadlessHost } from '../run/hosts/HeadlessHost.js';
import { childRunContext, MAX_RUN_DEPTH, RUN_CONTEXT_ERROR_CODES } from '../run/RunContext.js';
import { resolveRequestPrincipal } from '../run/principalResolver.js';
import { auditRefusal } from '../run/runAudit.js';

/**
 * Prefix of the tool an app becomes when another app may call it
 * (`app__<appId>`). Such tools belong to the apps-as-tools feature.
 */
export const APP_TOOL_ID_PREFIX = 'app__';

/** Most sources an app invoked as a tool hands back to its caller. */
const MAX_FORWARDED_SOURCES = 50;

function getAppById(appId) {
  const apps = configCache.getApps(true);
  if (!apps?.data) return null;
  return findByIdCaseInsensitive(apps.data, appId) || null;
}

function buildToolParameters(app) {
  const properties = {
    message: {
      type: 'string',
      description: 'The user-equivalent message you want this app to respond to.'
    }
  };
  const required = ['message'];

  if (Array.isArray(app.variables)) {
    for (const v of app.variables) {
      if (!v?.name) continue;
      let schemaType;
      switch (v.type) {
        case 'number':
          schemaType = 'number';
          break;
        case 'boolean':
          schemaType = 'boolean';
          break;
        case 'date':
        case 'select':
        case 'text':
        default:
          schemaType = 'string';
      }
      properties[v.name] = {
        type: schemaType,
        description: typeof v.label === 'string' ? v.label : v.label?.en || v.name
      };
      if (v.required && !required.includes(v.name)) required.push(v.name);
    }
  }

  return { type: 'object', properties, required };
}

function localizedDescription(app, language = 'en') {
  if (!app.description) return `Invoke iHub app ${app.id}.`;
  return getLocalizedString(app.description, language, undefined, app.id);
}

/**
 * Whether the principal is allowed to invoke the given app: the check the
 * chat HTTP route applies. Fails closed: a principal without resolved
 * permissions (none at all, or a bare object such as the removed Agent
 * Factory's agent principal) may invoke no app.
 *
 * @param {Object|null|undefined} user
 * @param {string} appId
 * @returns {boolean}
 */
export function isAppInvocationAllowed(user, appId) {
  if (!user?.permissions) return false;
  return canUserAccessResource(user, 'apps', appId);
}

/**
 * Whether users get the app: enabled, and every feature and integration it
 * requires is on.
 *
 * @param {Object} app
 * @returns {boolean}
 */
function isAppAvailable(app) {
  if (app.enabled === false || !areAppFeaturesEnabled(app, configCache.getFeatures())) {
    return false;
  }
  return areAppIntegrationsEnabled(app, configCache.getIntegrationContext());
}

/**
 * Build the synthetic tool descriptors for a list of app IDs.
 *
 * @param {string[]} appIds
 * @param {string} language
 * @param {Object} [options]
 * @param {Object} [options.user] - When given, apps the user may not access
 *   are omitted so the LLM never sees tools it cannot call; a user without
 *   resolved permissions gets none. Left out (the frozen legacy prompt node),
 *   nothing is filtered here and the call is refused at invocation.
 * @returns {Promise<Array>} tool descriptors
 */
export async function getAppAsTools(appIds, language = 'en', { user } = {}) {
  const tools = [];
  for (const appId of appIds) {
    const app = getAppById(appId);
    if (!app) {
      logger.warn('App-as-tool: app not found', { component: 'AppToolsGateway', appId });
      continue;
    }
    if (!isAppAvailable(app)) continue;
    if (user !== undefined && !isAppInvocationAllowed(user, app.id)) {
      logger.info('App-as-tool: app filtered by user permissions', {
        component: 'AppToolsGateway',
        appId: app.id,
        userId: user?.id || null
      });
      continue;
    }
    // name / description MUST be plain strings — Google's function_declarations
    // schema rejects nested objects ("Starting an object on a scalar field").
    // Other adapters' converters also pass these straight through. Resolve
    // locale here, do NOT re-wrap as a localized object.
    const appName = getLocalizedString(app.name, language, undefined, app.id);
    tools.push({
      id: `${APP_TOOL_ID_PREFIX}${app.id}`,
      name: `App: ${appName}`,
      // The title of the call's row in the chat: the app's localized name alone
      // (`toolDisplayOf`, decided on the server).
      appName,
      description: localizedDescription(app, language),
      parameters: buildToolParameters(app),
      // No `sideEffect`: what the app does depends on the tools it calls itself,
      // so the tool resolves to `unknown` and is never a trusted read (#2485).
      isAppAsTool: true,
      _appId: app.id
    });
  }
  return tools;
}

/**
 * Strip `app__*` tools from the array when the calling user is an agent.
 * Prevents an agent that's serving an app call from recursively calling more
 * apps.
 *
 * @param {Array} tools
 * @param {Object} user
 * @returns {Array}
 */
export function stripAppToolsForAgent(tools, user) {
  if (!user || user.isAgent !== true) return tools;
  if (!user.isInvokedViaAppAsTool) return tools;
  return tools.filter(
    t => !(t.id && typeof t.id === 'string' && t.id.startsWith(APP_TOOL_ID_PREFIX))
  );
}

/**
 * Invoke a synthetic app tool. Called by the tool runner
 * (`services/run/ToolRunner.js`) for chat apps and by
 * PromptNodeExecutor.executeToolCall for agent runs when the tool id matches
 * `app__<appId>`.
 *
 * Returns a SLIM payload — callers feed the result back into an LLM tool
 * message, so it must stay small: `{ content, sources?, usage?,
 * finishReason? }` or `{ error, message }`. `sources` is the app's source
 * set as the tool-result envelope (`services/sources/producers/envelope.js`),
 * so the calling chat lists what the app found; passages and snippets stay
 * behind, the model only needs what it cites.
 *
 * @param {Object} opts
 * @param {string} opts.toolId
 * @param {Object} opts.args - the model's arguments: `message` and the app's variables
 * @param {Object} opts.user - the caller's principal, with resolved permissions
 * @param {string} opts.chatId
 * @param {string} [opts.executionId]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {string} [opts.modelOverride]
 * @param {string} [opts.language]    caller's language, applied to the callee run
 * @param {string} [opts.callerAppId] id of the app making the call (audit only)
 * @param {Object<string, string>} [opts.integrationScopes] - the scopes the person picked for
 *   the calling chat; the called app works in them where it uses the same integrations
 * @param {string} [opts.clientTimezone] - the person's timezone
 * @param {Readonly<Object>} [opts.parentContext] - the run context of the calling run, when it
 *   runs on the run service
 */
export async function invokeAppTool({
  toolId,
  args = {},
  user,
  chatId,
  executionId,
  abortSignal,
  modelOverride,
  language,
  callerAppId,
  integrationScopes,
  clientTimezone,
  parentContext = null
}) {
  if (!toolId || !toolId.startsWith(APP_TOOL_ID_PREFIX)) {
    throw new Error(`Invalid app tool id: ${toolId}`);
  }
  const appId = toolId.slice(APP_TOOL_ID_PREFIX.length);

  // App→App nesting guard. `getToolsForApp` / `stripAppToolsForAgent` already
  // suppress `app__*` tools for nested principals; this rejects anything that
  // slips through (e.g. a hallucinated tool call).
  if (user?.isInvokedViaAppAsTool === true || (parentContext?.depth ?? 0) >= MAX_RUN_DEPTH) {
    return {
      error: true,
      message:
        'Nested app-to-app calls are not allowed (an app invoked as a tool cannot invoke further apps)'
    };
  }

  const app = getAppById(appId);
  if (!app) {
    return { error: true, message: `App ${appId} not found` };
  }
  if (!isAppAvailable(app)) {
    return { error: true, message: `App ${appId} is disabled` };
  }

  // Features live in features.json (configCache.getFeatures), not in
  // platform.json — the latter only held a stale leftover that never
  // tracked the canonical state.
  if (!isFeatureEnabled('appAsTool', configCache.getFeatures())) {
    return { error: true, message: 'features.appAsTool is disabled on this platform' };
  }

  // Enforce the calling user's app permissions — invoking an app through a
  // tool must not grant more access than opening it directly would, and a
  // caller without resolved permissions gets nothing.
  // Both refusals are written to the audit log: no run starts, so the run
  // service never sees them.
  const refuse = (code, message) => {
    auditRefusal({
      principal: user,
      resource: 'app',
      resourceId: app.id,
      code,
      origin: 'subagent',
      parentRunId: executionId || chatId,
      summary: `Refused to run app ${app.id}: ${message}`
    });
    return { error: true, message };
  };
  if (!isAppInvocationAllowed(user, app.id)) {
    return refuse(
      user?.permissions
        ? RUN_REFUSAL_CODES.APP_NOT_PERMITTED
        : RUN_CONTEXT_ERROR_CODES.PRINCIPAL_UNRESOLVED,
      `You do not have permission to access app ${app.id}`
    );
  }

  const resolved = resolveRequestPrincipal(user, { origin: parentContext?.origin ?? 'person' });
  if (!resolved.ok) return refuse(resolved.code, resolved.message);

  const messageBody = args.message || JSON.stringify(args);
  const messages = [{ role: 'user', content: messageBody }];
  const variables = { ...args };
  delete variables.message;

  logger.info('Invoking app via App-as-tool gateway', {
    component: 'AppToolsGateway',
    appId,
    callerAppId: callerAppId || null,
    callerUserId: user?.id,
    runId: executionId || chatId,
    modelOverride: modelOverride || null
  });

  try {
    // The callee runs one level deep, as the caller. Its context marks its
    // principal (`isInvokedViaAppAsTool`, from the depth), so it is offered no
    // further app tools.
    const context = childRunContext(parentContext, {
      principal: resolved.principal,
      parentRunId: executionId || chatId
    });
    const result = await runService.run(
      appRunSpec({
        context,
        appId: app.id,
        messages,
        variables,
        ...(language ? { language } : {}),
        signal: abortSignal,
        integrationScopes,
        clientTimezone,
        // Propagate the calling agent's model into the app so the operator's
        // model choice flows through the whole call tree; with a modelId set
        // here it wins over the app's preferred model.
        ...(modelOverride ? { modelId: modelOverride } : {}),
        caller: 'subagent'
      }),
      new HeadlessHost()
    );

    // Return a SLIM payload to the caller. The run's result can carry the full
    // tool calls and other large extras. Callers invoke this gateway from
    // inside an LLM tool loop, so whatever we return gets JSON.stringify'd
    // into a tool message and fed back to the model. Keep only:
    //   - content: the actual answer the app produced
    //   - sources: what the app found, for the caller's sources panel
    //   - usage: token counts (optional, useful for audit)
    //   - finishReason: brief stop reason
    if (result?.status === 'error') {
      return {
        error: true,
        message: result.error?.message || result.error || 'app invocation failed'
      };
    }
    const content =
      (result?.finalMessage && typeof result.finalMessage.content === 'string'
        ? result.finalMessage.content.trim()
        : '') || '';
    const sources = (result?.sources?.items || [])
      .slice(0, MAX_FORWARDED_SOURCES)
      // Explicit `private`: the envelope treats a source that names none as private.
      .map(({ passages: _passages, snippet: _snippet, ...source }) => ({
        ...source,
        private: source.private === true
      }));
    return {
      content,
      ...(sources.length > 0 ? { sources } : {}),
      ...(result?.usage ? { usage: result.usage } : {}),
      ...(result?.finishReason ? { finishReason: result.finishReason } : {})
    };
  } catch (err) {
    logger.error('App-as-tool invocation failed', {
      component: 'AppToolsGateway',
      appId,
      error: err.message
    });
    return { error: true, message: err.message };
  }
}

export default { getAppAsTools, stripAppToolsForAgent, invokeAppTool, isAppInvocationAllowed };
