import path from 'path';
import ChatService from '../chat/ChatService.js';
import { isValidId } from '../../utils/pathSecurity.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';

const chatService = new ChatService();

/**
 * Validate a caller-supplied app id and resolve the app from the config cache.
 *
 * `path.basename` is the canonical CodeQL-recognised sanitiser for path
 * injection; combined with the exact-match check it fails closed on anything
 * containing `/`, `\\` or `..`.
 *
 * @param {unknown} appId
 * @returns {Object} The trusted app config
 * @throws {Error} Invalid id or unknown app
 */
export function resolveInvokableApp(appId) {
  if (typeof appId !== 'string') {
    throw new Error(`Invalid app id: ${appId}`);
  }
  const safeAppId = path.basename(appId);
  if (safeAppId !== appId || !isValidId(safeAppId)) {
    throw new Error(`Invalid app id: ${appId}`);
  }
  const { data: apps = [] } = configCache.getApps();
  const app = findByIdCaseInsensitive(apps, safeAppId);
  if (!app) {
    throw new Error(`App not found: ${safeAppId}`);
  }
  return app;
}

/**
 * Run an iHub app headlessly on the shared agent loop and return its answer.
 *
 * Shared by every server-side caller that has no browser to stream to: the
 * MCP gateway (`tools/call`), the A2A endpoint (`message/send`,
 * `message/stream`) and the app-as-tool bridge. Prompt templating, variables,
 * model selection, tools and structured output are the app's; interactive
 * tools are refused because no user can answer.
 *
 * @param {Object} params
 * @param {string} params.appId - App id; validated and resolved against the config cache
 * @param {Array<{role: string, content: string}>} params.messages - Conversation, last entry the user's message
 * @param {Object} [params.variables] - App variables for the prompt template
 * @param {Object} params.user - Acting user (req.user-like), used for permissions and the ledger
 * @param {string} [params.modelId] - Optional model override (checked against the app's models)
 * @param {string} [params.language] - Response language; defaults to the platform default
 * @param {string} [params.runId] - Caller's run id (parent in the ledger)
 * @param {number} [params.timeoutMs=60000] - Hard timeout for each model call
 * @param {number} [params.maxWallClockMs] - Deadline for the whole invocation
 * @param {AbortSignal} [params.abortSignal]
 * @param {(text: string) => void} [params.onTextDelta] - Streamed text fragments
 * @returns {Promise<{text: string, result: Object}>} Assistant text ('' when none) and the raw result
 * @throws {Error} Invalid input, unknown app, request preparation or provider failure (`err.code`)
 */
export async function invokeApp({
  appId,
  messages,
  variables = {},
  user,
  modelId,
  language,
  runId,
  timeoutMs = 60000,
  maxWallClockMs,
  abortSignal,
  onTextDelta
}) {
  const app = resolveInvokableApp(appId);
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (!last || last.role !== 'user' || typeof last.content !== 'string' || !last.content.trim()) {
    throw new Error("Missing required argument: 'message'");
  }

  const result = await chatService.invokeAppInternal({
    appId: app.id, // trusted value from configCache, not user input
    user,
    messages: list,
    variables,
    modelOverride: modelId, // undefined → RequestBuilder picks app.preferredModel
    language: language || configCache.getPlatform()?.defaultLanguage || 'en',
    runId: runId || `mcp-${Date.now()}`,
    timeoutMs,
    ...(maxWallClockMs ? { maxWallClockMs } : {}),
    ...(abortSignal ? { abortSignal } : {}),
    ...(onTextDelta ? { onTextDelta } : {})
  });

  if (result.status !== 'ok') {
    const err = new Error(result.error?.message || 'App invocation failed');
    err.code = result.error?.code || 'APP_INVOCATION_FAILED';
    throw err;
  }

  const text = result.finalMessage?.content || '';
  if (!text) {
    logger.warn('App invocation produced empty content', {
      component: 'McpAppInvoker',
      appId: app.id,
      modelId: result.model,
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls?.length ?? 0
    });
  }
  return { text, result };
}

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
  const message = args?.message;
  if (typeof message !== 'string' || !message.trim()) {
    // Validate the app first so an unknown app is reported as such even
    // without a message — but only after the id itself proved safe.
    resolveInvokableApp(appId);
    throw new Error("Missing required argument: 'message'");
  }

  // Optional model override. RequestBuilder checks it against the app's
  // allowed/compatible models and falls back to the preferred model if the
  // requested one is missing or incompatible, so an unknown id can't error.
  // RequestBuilder also enforces the caller's `permissions.models` here,
  // same as the chat route: a model outside the user's group allowlist
  // throws `modelAccessDeniedForUser` instead of silently substituting.
  const modelId =
    typeof args?.modelId === 'string' && args.modelId.trim() ? args.modelId.trim() : undefined;

  // The MCP tool surface treats every remaining non-reserved arg as an app
  // variable so the prompt template can interpolate ${var}.
  const variables = { ...args };
  delete variables.message;
  delete variables.modelId;

  const { text } = await invokeApp({
    appId,
    messages: [{ role: 'user', content: message }],
    variables,
    user,
    modelId,
    language,
    timeoutMs
  });
  return text;
}
