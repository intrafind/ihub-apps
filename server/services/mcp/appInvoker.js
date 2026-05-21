import path from 'path';
import RequestBuilder from '../chat/RequestBuilder.js';
import { throttledFetch } from '../../requestThrottler.js';
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
 * machinery. The LLM request is fired off via `throttledFetch` and we
 * extract the assistant text from the provider's response payload.
 *
 * Tool calling, structured output, and multi-modal generation are not
 * yet supported on this path — those need the full chat pipeline. Apps
 * that depend on those features should still be called via the web UI
 * or the streaming /api/chat endpoint.
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

  // The MCP tool surface treats every non-message arg as an app variable so
  // the prompt template can interpolate ${var}. Drop falsy values.
  const variables = { ...args };
  delete variables.message;

  const builder = new RequestBuilder();
  const prep = await builder.prepareChatRequest({
    appId: app.id, // trusted value from configCache, not user input
    modelId: undefined, // RequestBuilder picks app.preferredModel
    messages: [{ role: 'user', content: message, variables }],
    temperature: undefined,
    style: undefined,
    outputFormat: undefined,
    language: language || configCache.getPlatform()?.defaultLanguage || 'en',
    useMaxTokens: false,
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

  const { model, request } = prep.data;

  // Hard timeout on the LLM call so a wedged provider doesn't keep an MCP
  // session blocked.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await throttledFetch(model.id, request.url, {
      method: request.method || 'POST',
      headers: request.headers || {},
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Upstream model error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  const text = extractAssistantText(model.provider, data);
  if (!text) {
    logger.warn('MCP app invocation produced empty content', {
      component: 'McpAppInvoker',
      appId,
      modelId: model.id,
      provider: model.provider
    });
  }
  return text;
}

/**
 * Pull the assistant's text out of a non-streaming provider response.
 * Providers differ in shape — covers OpenAI/Mistral/vLLM (`choices[0].message.content`),
 * Anthropic (`content[].text`), Google (`candidates[0].content.parts[].text`),
 * and OpenAI Responses (`output[].content[].text`).
 */
function extractAssistantText(provider, data) {
  if (!data) return '';

  // OpenAI-compatible chat completions.
  if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
    const msg = data.choices[0].message || data.choices[0].delta;
    if (typeof msg?.content === 'string') return msg.content;
    if (Array.isArray(msg?.content)) {
      return msg.content
        .filter(p => p?.type === 'text' || typeof p?.text === 'string')
        .map(p => p.text || '')
        .join('');
    }
  }

  // Anthropic.
  if (data.content && Array.isArray(data.content)) {
    return data.content
      .filter(p => p?.type === 'text')
      .map(p => p.text || '')
      .join('');
  }

  // Google Generative AI.
  if (data.candidates && Array.isArray(data.candidates) && data.candidates[0]) {
    const parts = data.candidates[0].content?.parts;
    if (Array.isArray(parts)) {
      return parts
        .filter(p => typeof p?.text === 'string')
        .map(p => p.text)
        .join('');
    }
  }

  // OpenAI Responses API.
  if (data.output && Array.isArray(data.output)) {
    const chunks = [];
    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string') chunks.push(c.text);
        }
      }
    }
    return chunks.join('');
  }

  logger.warn('Unrecognised provider response shape', {
    component: 'McpAppInvoker',
    provider,
    keys: Object.keys(data).slice(0, 10)
  });
  return '';
}
