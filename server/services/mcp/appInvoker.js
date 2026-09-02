import path from 'path';
import RequestBuilder from '../chat/RequestBuilder.js';
import llmClient from '../loop/LLMClient.js';
import { processMessageTemplates } from '../../serverHelpers.js';
import { isValidId } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/**
 * Invoke an iHub app through the MCP gateway in **non-streaming** mode and
 * return the assistant text as a plain string.
 *
 * The iHub web UI drives apps via SSE streaming over `/api/chat`. MCP
 * `tools/call` is request-response, so we reuse `RequestBuilder` (which
 * already handles prompt templating, system prompt, variables, model
 * selection, API key resolution, and token budgeting) but skip the SSE
 * machinery. The model call itself goes through `LLMClient.complete()` —
 * the single provider gateway — which owns throttling, transient retries,
 * the canonical `LLMError` taxonomy, response parsing for every provider
 * and the run-ledger envelope (`kind: 'subagent'`).
 *
 * Tool calling, structured output, and multi-modal generation are not
 * yet supported on this path — those need the full chat pipeline. Apps
 * that depend on those features should still be called via the web UI
 * or the streaming /api/chat endpoint.
 *
 * @param {Object} params
 * @param {string} params.appId - App id; validated against the configCache app list
 * @param {Object} params.args - MCP tool arguments. `message` is required, `modelId` is an
 *   optional override, every other key is passed to the app as a prompt variable
 * @param {Object} params.user - Acting user (req.user-like), used for permissions and the ledger
 * @param {string} [params.language] - Response language; defaults to the platform default
 * @param {number} [params.timeoutMs=60000] - Hard timeout for the model call
 * @returns {Promise<string>} Assistant text ('' when the model produced none)
 * @throws {Error} Invalid input, unknown app, or request preparation failure (`err.code`)
 * @throws {import('../loop/contracts/errors.js').LLMError} Provider failures (`err.code`, `err.status`)
 */
export async function invokeAppNonStreaming({ appId, args, user, language, timeoutMs = 60000 }) {
  // The caller (McpServerService) binds appId at MCP tool registration
  // time from the trusted configCache list, but enforce defence-in-depth
  // here so the function is safe to expose more broadly. path.basename
  // is the canonical CodeQL-recognised sanitiser for path injection;
  // combined with the exact-match check it fails closed on anything
  // containing /, \, or ..
  if (typeof appId !== 'string') {
    throw new Error(`Invalid app id: ${appId}`);
  }
  const safeAppId = path.basename(appId);
  if (safeAppId !== appId || !isValidId(safeAppId)) {
    throw new Error(`Invalid app id: ${appId}`);
  }

  const message = args?.message;
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error("Missing required argument: 'message'");
  }

  // Look up the app against configCache; pass only the trusted app.id
  // back downstream so the user-controlled appId stops here.
  const { data: apps = [] } = configCache.getApps();
  const app = apps.find(a => a.id === safeAppId);
  if (!app) {
    throw new Error(`App not found: ${safeAppId}`);
  }

  // Optional model override. RequestBuilder checks it against the app's
  // allowed/compatible models and falls back to the preferred model if the
  // requested one is missing or incompatible, so an unknown id can't error.
  // This is not a per-user model-permission gate (RequestBuilder doesn't
  // enforce `permissions.models` here, same as the chat route); it only
  // respects the app's `allowedModels`.
  const modelId =
    typeof args?.modelId === 'string' && args.modelId.trim() ? args.modelId.trim() : undefined;

  // The MCP tool surface treats every remaining non-reserved arg as an app
  // variable so the prompt template can interpolate ${var}.
  const variables = { ...args };
  delete variables.message;
  delete variables.modelId;

  const builder = new RequestBuilder();
  const prep = await builder.prepareChatRequest({
    appId: app.id, // trusted value from configCache, not user input
    modelId, // undefined → RequestBuilder picks app.preferredModel
    messages: [{ role: 'user', content: message, variables }],
    temperature: undefined,
    style: undefined,
    outputFormat: undefined,
    language: language || configCache.getPlatform()?.defaultLanguage || 'en',
    bypassAppPrompts: false,
    processMessageTemplates,
    // No res/clientRes — RequestBuilder treats this as non-streaming.
    res: null,
    clientRes: null,
    user,
    chatId: `mcp-${Date.now()}`
  });

  if (!prep.success) {
    const err = new Error(prep.error?.message || 'Failed to prepare chat request');
    err.code = prep.error?.code || 'PREP_FAILED';
    throw err;
  }

  // RequestBuilder already resolved the model, the API key and the fully
  // templated message list; hand those to LLMClient rather than re-resolving.
  const { model, llmMessages, tools, apiKey, temperature, maxTokens } = prep.data;

  const result = await llmClient.complete({
    model,
    apiKey,
    messages: llmMessages,
    options: {
      temperature,
      maxTokens,
      tools: Array.isArray(tools) && tools.length > 0 ? tools : undefined
    },
    stream: false,
    // Hard timeout so a wedged provider doesn't keep an MCP session blocked.
    timeoutMs,
    telemetry: {
      kind: 'subagent',
      purpose: 'mcp-app-invoke',
      user,
      refs: { appId: app.id }
    }
  });

  const text = result.content || '';
  if (!text) {
    logger.warn('MCP app invocation produced empty content', {
      component: 'McpAppInvoker',
      appId: app.id,
      modelId: model.id,
      provider: model.provider,
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls?.length ?? 0
    });
  }
  return text;
}
