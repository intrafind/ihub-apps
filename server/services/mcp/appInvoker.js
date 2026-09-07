import path from 'path';
import ChatService from '../chat/ChatService.js';
import { isValidId } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

const chatService = new ChatService();

/**
 * Invoke an iHub app through the MCP gateway in **non-streaming** mode and
 * return the assistant text as a plain string.
 *
 * The iHub web UI drives apps via SSE streaming over `/api/chat`. MCP
 * `tools/call` is request-response, so we reuse `RequestBuilder` (which
 * already handles prompt templating, system prompt, variables, model
 * selection, API key resolution, and token budgeting) and run the turn
 * headlessly on the shared agent loop (`ChatService.invokeAppInternal`):
 * tools execute server-side, structured output applies, interactive tools
 * are refused because no user can answer, and the model calls go through
 * `LLMClient` (throttling, retries, `LLMError` taxonomy, run ledger).
 *
 * @param {Object} params
 * @param {string} params.appId - App id; validated against the configCache app list
 * @param {Object} params.args - MCP tool arguments. `message` is required, `modelId` is an
 *   optional override, every other key is passed to the app as a prompt variable
 * @param {Object} params.user - Acting user (req.user-like), used for permissions and the ledger
 * @param {string} [params.language] - Response language; defaults to the platform default
 * @param {number} [params.timeoutMs=60000] - Hard timeout for the model call
 * @returns {Promise<string>} Assistant text ('' when the model produced none)
 * @throws {Error} Invalid input, unknown app, request preparation or provider failure (`err.code`)
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

  // The shared chat service runs the app exactly like a chat turn — tools
  // execute server-side, interactive tools are refused (no user can answer) —
  // and hands back the assembled answer.
  const result = await chatService.invokeAppInternal({
    appId: app.id, // trusted value from configCache, not user input
    user,
    messages: [{ role: 'user', content: message }],
    variables,
    modelOverride: modelId, // undefined → RequestBuilder picks app.preferredModel
    language: language || configCache.getPlatform()?.defaultLanguage || 'en',
    runId: `mcp-${Date.now()}`,
    timeoutMs
  });

  if (result.status !== 'ok') {
    const err = new Error(result.error?.message || 'App invocation failed');
    err.code = result.error?.code || 'APP_INVOCATION_FAILED';
    throw err;
  }

  const text = result.finalMessage?.content || '';
  if (!text) {
    logger.warn('MCP app invocation produced empty content', {
      component: 'McpAppInvoker',
      appId: app.id,
      modelId: result.model,
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls?.length ?? 0
    });
  }
  return text;
}
