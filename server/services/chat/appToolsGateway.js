/**
 * App Tools Gateway
 *
 * The shared internal interface for invoking iHub Apps programmatically —
 * server-side, without going through the REST API. Every caller that wants
 * another app to answer a message routes through here:
 *
 *  - **Chat apps** (`app.apps: [...]`): `getToolsForApp()` surfaces the listed
 *    apps as synthetic `app__<appId>` tools; `runTool()` dispatches them to
 *    `invokeAppTool()` (the "concierge" pattern — a bot delegating to
 *    specialist bots).
 *  - **Agent workflow nodes** (`node.config.apps`): PromptNodeExecutor
 *    registers the same synthetic tools and calls `invokeAppTool()` directly.
 *
 * Each tool's parameters are derived from `app.variables` and its description
 * is the localized app description. Invocation routes through
 * `ChatService.invokeAppInternal()`, which runs the standard chat pipeline
 * (model resolution, system prompt, tool loop) against an in-memory sink.
 *
 * Guard rails:
 *  - `features.appAsTool` must be enabled.
 *  - Principals that carry resolved `permissions` (regular chat users) may
 *    only invoke apps they are allowed to access — the same check
 *    `chatAuthRequired` applies on the HTTP route. Bare agent principals
 *    (no `permissions` object) are operator-configured and skip this check.
 *  - App→App nesting is disallowed: the callee runs with
 *    `isInvokedViaAppAsTool: true`, which suppresses further `app__*` tools
 *    (see `getToolsForApp`) and is rejected outright by `invokeAppTool()`.
 */

import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import ChatService from './ChatService.js';
import { getLocalizedString } from '../../utils/localize.js';
import { canUserAccessResource } from '../../utils/authorization.js';

const chatService = new ChatService();

function getAppById(appId) {
  const apps = configCache.getApps(true);
  if (!apps?.data) return null;
  return apps.data.find(a => a.id === appId) || null;
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
 * Whether the principal is allowed to invoke the given app. Principals with
 * resolved permissions (regular users, incl. materialized anonymous users)
 * get the same check the chat HTTP route applies. Principals WITHOUT a
 * permissions object (bare agent principals) pass — which apps an agent may
 * call is operator-configured on the workflow node.
 *
 * @param {Object} user
 * @param {string} appId
 * @returns {boolean}
 */
export function isAppInvocationAllowed(user, appId) {
  if (!user || !user.permissions) return true;
  return canUserAccessResource(user, 'apps', appId);
}

/**
 * Build the synthetic tool descriptors for a list of app IDs.
 *
 * @param {string[]} appIds
 * @param {string} language
 * @param {Object} [options]
 * @param {Object} [options.user] - When given (and it carries resolved
 *   permissions), apps the user may not access are omitted so the LLM never
 *   sees tools it cannot call.
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
    if (app.enabled === false) continue;
    if (user && !isAppInvocationAllowed(user, appId)) {
      logger.info('App-as-tool: app filtered by user permissions', {
        component: 'AppToolsGateway',
        appId,
        userId: user.id
      });
      continue;
    }
    // name / description MUST be plain strings — Google's function_declarations
    // schema rejects nested objects ("Starting an object on a scalar field").
    // Other adapters' converters also pass these straight through. Resolve
    // locale here, do NOT re-wrap as a localized object.
    const appName = getLocalizedString(app.name, language, undefined, app.id);
    tools.push({
      id: `app__${appId}`,
      name: `App: ${appName}`,
      description: localizedDescription(app, language),
      parameters: buildToolParameters(app),
      isAppAsTool: true,
      _appId: appId
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
  return tools.filter(t => !(t.id && typeof t.id === 'string' && t.id.startsWith('app__')));
}

/**
 * Invoke a synthetic app tool. Called by `runTool()` for chat apps and by
 * PromptNodeExecutor.executeToolCall for agent runs when the tool id matches
 * `app__<appId>`.
 *
 * Returns a SLIM payload — callers feed the result back into an LLM tool
 * message, so it must stay small: `{ content, citations?, usage?,
 * finishReason? }` or `{ error, message }`.
 *
 * @param {Object} opts
 * @param {string} opts.toolId
 * @param {Object} opts.args
 * @param {Object} opts.user
 * @param {string} opts.chatId
 * @param {string} [opts.executionId]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {string} [opts.modelOverride]
 * @param {string} [opts.language]    caller's language, applied to the callee run
 * @param {string} [opts.callerAppId] id of the app making the call (audit only)
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
  callerAppId
}) {
  if (!toolId || !toolId.startsWith('app__')) {
    throw new Error(`Invalid app tool id: ${toolId}`);
  }
  const appId = toolId.slice('app__'.length);

  // App→App nesting guard. `getToolsForApp` / `stripAppToolsForAgent` already
  // suppress `app__*` tools for nested principals; this rejects anything that
  // slips through (e.g. a hallucinated tool call).
  if (user?.isInvokedViaAppAsTool === true) {
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
  if (app.enabled === false) {
    return { error: true, message: `App ${appId} is disabled` };
  }

  // Features live in features.json (configCache.getFeatures), not in
  // platform.json — the latter only held a stale leftover that never
  // tracked the canonical state.
  if (!isFeatureEnabled('appAsTool', configCache.getFeatures())) {
    return { error: true, message: 'features.appAsTool is disabled on this platform' };
  }

  // Enforce the calling user's app permissions — invoking an app through a
  // tool must not grant more access than opening it directly would.
  if (!isAppInvocationAllowed(user, appId)) {
    return { error: true, message: `You do not have permission to access app ${appId}` };
  }

  const messageBody = args.message || JSON.stringify(args);
  const messages = [{ role: 'user', content: messageBody }];
  const variables = { ...args };
  delete variables.message;

  // Mark the principal so nested calls strip further app__ tools.
  const nestedUser = { ...(user || {}), isInvokedViaAppAsTool: true };

  logger.info('Invoking app via App-as-tool gateway', {
    component: 'AppToolsGateway',
    appId,
    callerAppId: callerAppId || null,
    callerUserId: user?.id,
    runId: executionId || chatId,
    modelOverride: modelOverride || null
  });

  try {
    const result = await chatService.invokeAppInternal({
      appId,
      user: nestedUser,
      messages,
      variables,
      abortSignal,
      runId: executionId || chatId,
      ...(language ? { language } : {}),
      // Propagate the calling agent's model into the app so the operator's
      // model choice flows through the whole call tree instead of every
      // app silently running on whatever bedrock-nova-* the app config
      // shipped with. App authors can still override per-app if needed
      // by leaving their own modelId in the config and not setting one
      // on the calling profile, but with a modelId set here it wins.
      ...(modelOverride ? { modelOverride } : {})
    });

    // Return a SLIM payload to the caller. The internal result from
    // `invokeAppInternal` can carry adapter-specific debug fields, full raw
    // responses with chain-of-thought, and other large extras. Callers invoke
    // this gateway from inside an LLM tool loop, so whatever we return
    // gets JSON.stringify'd into a tool message and fed back to the model.
    // Returning the unfiltered object blows up the caller's context (the
    // user observed 10KB+ of Gemini thought text leaking in). Keep only:
    //   - content: the actual answer the app produced
    //   - citations: any source URLs the app cited
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
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    return {
      content,
      ...(citations.length > 0 ? { citations } : {}),
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
