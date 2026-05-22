/**
 * App-as-Tool Gateway
 *
 * Translates iHub Apps into synthetic tools an agent can call. Each registered
 * app surfaces as a tool named `app__<appId>` whose parameters are derived from
 * `app.variables` and whose description is the localized app description.
 *
 * Invocation routes through `ChatService.invokeAppInternal()`, which runs the
 * standard chat pipeline against an in-memory sink.
 *
 * App→App nesting is disallowed: when the calling principal is itself an agent,
 * `app__*` tools are stripped from the prepared tool list before LLM dispatch.
 */

import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import ChatService from '../../services/chat/ChatService.js';

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
  if (typeof app.description === 'string') return app.description;
  return (
    app.description[language] || app.description.en || Object.values(app.description)[0] || app.id
  );
}

/**
 * Build the synthetic tool descriptors for a list of app IDs.
 *
 * @param {string[]} appIds
 * @param {string} language
 * @returns {Promise<Array>} tool descriptors
 */
export async function getAppAsTools(appIds, language = 'en') {
  const tools = [];
  for (const appId of appIds) {
    const app = getAppById(appId);
    if (!app) {
      logger.warn('App-as-tool: app not found', { component: 'AppAsToolGateway', appId });
      continue;
    }
    if (app.enabled === false) continue;
    // name / description MUST be plain strings — Google's function_declarations
    // schema rejects nested objects ("Starting an object on a scalar field").
    // Other adapters' converters also pass these straight through. Resolve
    // locale here, do NOT re-wrap as a localized object.
    const appName =
      typeof app.name === 'string'
        ? app.name
        : app.name?.[language] || app.name?.en || Object.values(app.name || {})[0] || app.id;
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
 * Invoke a synthetic app tool. Called by PromptNodeExecutor.executeToolCall
 * when the tool id matches `app__<appId>`.
 *
 * @param {Object} opts
 * @param {string} opts.toolId
 * @param {Object} opts.args
 * @param {Object} opts.user
 * @param {string} opts.chatId
 * @param {string} opts.executionId
 * @param {AbortSignal} [opts.abortSignal]
 */
export async function invokeAppTool({
  toolId,
  args = {},
  user,
  chatId,
  executionId,
  abortSignal,
  modelOverride
}) {
  if (!toolId || !toolId.startsWith('app__')) {
    throw new Error(`Invalid app tool id: ${toolId}`);
  }
  const appId = toolId.slice('app__'.length);
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

  const messageBody = args.message || JSON.stringify(args);
  const messages = [{ role: 'user', content: messageBody }];
  const variables = { ...args };
  delete variables.message;

  // Mark the principal so nested calls strip further app__ tools.
  const nestedUser = { ...(user || {}), isInvokedViaAppAsTool: true };

  logger.info('Invoking app via App-as-tool gateway', {
    component: 'AppAsToolGateway',
    appId,
    callerUserId: user?.id,
    runId: executionId,
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
    // responses with chain-of-thought, and other large extras. Agents call
    // this gateway from inside an LLM tool loop, so whatever we return
    // gets JSON.stringify'd into a tool message and fed back to the model.
    // Returning the unfiltered object blows up the agent's context (the
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
      component: 'AppAsToolGateway',
      appId,
      error: err.message
    });
    return { error: true, message: err.message };
  }
}

export default { getAppAsTools, stripAppToolsForAgent, invokeAppTool };
