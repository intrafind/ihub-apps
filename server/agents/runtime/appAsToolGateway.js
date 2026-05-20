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
      let schemaType = 'string';
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
    tools.push({
      id: `app__${appId}`,
      name: { en: `App: ${app.name?.en || app.id}` },
      description: { en: localizedDescription(app, language) },
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
export async function invokeAppTool({ toolId, args = {}, user, chatId, executionId, abortSignal }) {
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

  const platform = configCache.getPlatform()?.data || {};
  if (!platform?.features?.appAsTool) {
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
    runId: executionId
  });

  try {
    const result = await chatService.invokeAppInternal({
      appId,
      user: nestedUser,
      messages,
      variables,
      abortSignal,
      runId: executionId || chatId
    });
    return result;
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
