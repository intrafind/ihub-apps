/**
 * Model endpoint discovery for the admin "Import from URL" dialog.
 *
 * An admin points iHub at a provider's model listing — OpenAI, Mistral, vLLM,
 * LM Studio, T-Systems AI Foundation Services (LLM Hub), OpenRouter,
 * Anthropic or Google — with or without an API key. The listing is fetched
 * once and normalized into one entry shape the admin can pick models from;
 * nothing is stored here. The chosen entries become ordinary model configs
 * through `POST /api/admin/models`.
 *
 * Imported models are linked to a provider entry that holds the key (see
 * shared/llmProviders.js), so no model carries a key of its own.
 *
 * Distinct from `ModelDiscoveryService`, which runs at request time and
 * swaps the configured `modelId` of one `autoDiscovery` model for whatever
 * model a local server currently serves.
 */

import { httpFetch, redactUrlSecrets } from '../utils/httpConfig.js';
import logger from '../utils/logger.js';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  MAX_OUTPUT_TOKENS_MAX,
  MAX_OUTPUT_TOKENS_MIN
} from '../../shared/validationPatterns.js';
import { CUSTOM_PROVIDER_API_TYPES } from '../../shared/llmProviders.js';

/**
 * API types whose `/models` listing this module knows how to call and read —
 * the same ones a custom LLM provider can declare.
 */
export const DISCOVERY_PROVIDERS = CUSTOM_PROVIDER_API_TYPES;

/** Hard cap for the listing call (interactive admin request). */
const DISCOVERY_TIMEOUT_MS = 15000;

/** Largest listing body read. OpenRouter's full catalog is about 1 MB. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Most entries returned to the browser. */
const MAX_MODELS = 5000;

/**
 * Error raised for anything the admin has to fix: a bad URL, an endpoint that
 * rejects the key, a body that is not a model listing. `messageKey` is the
 * stable identifier the client translates; `status` is the HTTP status the
 * route answers with.
 */
export class ModelDiscoveryError extends Error {
  constructor(messageKey, message, { status = 502, details, upstreamStatus } = {}) {
    super(message);
    this.name = 'ModelDiscoveryError';
    this.messageKey = messageKey;
    this.status = status;
    this.details = details;
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * `value` without trailing slashes. A loop rather than `/\/+$/`, whose
 * backtracking is quadratic on input made of many slashes.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/**
 * Trailing path segments that name an inference call rather than the API
 * root. Stripping one leaves the base the `/models` listing hangs off.
 */
const CALL_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages'];

/**
 * Turn whatever URL the admin pasted into the listing URL and the API base.
 *
 * Accepted forms, using an OpenAI-compatible server as the example:
 *   - the listing itself:          https://host/v1/models
 *   - the API base:                https://host/v1
 *   - an inference URL:            https://host/v1/chat/completions
 *   - a bare host:                 https://host  (→ /v1/models, /v1beta for Google)
 *   - for Google, a model URL:     …/v1beta/models/gemini-x:streamGenerateContent
 *
 * Query string and fragment are dropped: credentials belong in the API key
 * field, not in a URL that ends up in stored model configs.
 *
 * @param {string} input - URL entered by the admin
 * @param {string} provider - One of {@link DISCOVERY_PROVIDERS}
 * @returns {{ modelsUrl: string, baseUrl: string }}
 * @throws {ModelDiscoveryError} for anything that is not an http(s) URL
 */
export function resolveModelsEndpoint(input, provider) {
  const raw = typeof input === 'string' ? input.trim() : '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ModelDiscoveryError('invalidUrl', 'Enter a valid http:// or https:// URL', {
      status: 400
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelDiscoveryError('invalidUrl', 'Enter a valid http:// or https:// URL', {
      status: 400
    });
  }
  if (parsed.username || parsed.password) {
    throw new ModelDiscoveryError(
      'credentialsInUrl',
      'Remove the credentials from the URL and enter the key in the API key field',
      { status: 400 }
    );
  }

  let path = stripTrailingSlashes(parsed.pathname);

  if (provider === 'google') {
    // A model URL: …/models/gemini-x:streamGenerateContent → …/models
    path = path.replace(/\/models\/[^/]+$/, '/models');
  } else {
    const suffix = CALL_SUFFIXES.find(s => path.toLowerCase().endsWith(s));
    if (suffix) path = path.slice(0, -suffix.length);
  }

  if (!path.toLowerCase().endsWith('/models')) {
    if (!path) path = provider === 'google' ? '/v1beta' : '/v1';
    path = `${path}/models`;
  }

  const origin = parsed.origin;
  return {
    modelsUrl: `${origin}${path}`,
    baseUrl: `${origin}${path.slice(0, -'/models'.length)}`
  };
}

/**
 * Request headers for the listing call. Without a key, no credential header is
 * sent at all — a local vLLM or LM Studio server answers anonymously.
 *
 * @param {string} provider
 * @param {string} [apiKey]
 * @returns {Record<string, string>}
 */
export function buildDiscoveryHeaders(provider, apiKey) {
  const headers = { Accept: 'application/json' };
  if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (!apiKey) return headers;
  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey;
  } else if (provider === 'google') {
    headers['x-goog-api-key'] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * The inference URL a model imported from `baseUrl` is called on.
 *
 * @param {string} provider
 * @param {string} baseUrl - API base returned by {@link resolveModelsEndpoint}
 * @param {string} modelId - Remote model id
 * @returns {string}
 */
export function buildInferenceUrl(provider, baseUrl, modelId) {
  switch (provider) {
    case 'openai-responses':
      return `${baseUrl}/responses`;
    case 'anthropic':
      return `${baseUrl}/messages`;
    case 'google':
      return `${baseUrl}/models/${encodeURIComponent(modelId)}:streamGenerateContent`;
    default:
      return `${baseUrl}/chat/completions`;
  }
}

/** First argument that is a positive integer within [min, max], else null. */
function firstTokenCount(min, max, ...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function lowerList(value) {
  return Array.isArray(value)
    ? value.filter(v => typeof v === 'string').map(v => v.trim().toLowerCase())
    : [];
}

/** Type words providers put in a model's own `type` / `model_type` field. */
const DECLARED_TYPES = {
  llm: 'chat',
  chat: 'chat',
  language: 'chat',
  vlm: 'chat',
  embedding: 'embedding',
  embeddings: 'embedding',
  rerank: 'rerank',
  reranker: 'rerank',
  image: 'image',
  moderation: 'moderation',
  audio: 'audio',
  stt: 'audio',
  asr: 'audio',
  tts: 'audio',
  transcribe: 'audio',
  transcription: 'audio'
};

/**
 * Guess a model's type from its id when the listing does not say. Only
 * patterns that do not match chat models' names are used; everything else is
 * treated as a chat model.
 */
function typeFromId(id) {
  const s = id.toLowerCase();
  if (/rerank/.test(s)) return 'rerank';
  if (/embed|(^|[-_/])(bge|gte|e5)[-_]/.test(s)) return 'embedding';
  if (/moderation/.test(s)) return 'moderation';
  if (/whisper|(^|[-_/])tts([-_]|$)|transcribe|speech|realtime/.test(s)) return 'audio';
  if (/dall-e|gpt-image|imagen|stable-diffusion|sdxl|(^|[-_/])flux/.test(s)) return 'image';
  if (/(^|[-_/])ocr([-_]|$)/.test(s)) return 'other';
  return 'chat';
}

function classifyType(item, meta, id) {
  const declared = firstString(meta.model_type, item.type);
  if (declared) {
    const mapped = DECLARED_TYPES[declared.toLowerCase()];
    if (mapped) return mapped;
    // Mistral: "base"/"fine-tuned"; Anthropic: "model" — not a type statement.
  }

  if (item.capabilities && typeof item.capabilities === 'object') {
    // Mistral
    if (item.capabilities.completion_chat === true) return 'chat';
    if (item.capabilities.completion_chat === false) {
      const guess = typeFromId(id);
      return guess === 'chat' ? 'other' : guess;
    }
  }

  const methods = item.supportedGenerationMethods;
  if (Array.isArray(methods)) {
    // Google
    if (methods.includes('generateContent')) return 'chat';
    if (methods.includes('embedContent') || methods.includes('embedText')) return 'embedding';
    if (methods.includes('bidiGenerateContent')) return 'audio';
    if (methods.includes('predict')) return 'image';
    return 'other';
  }

  return typeFromId(id);
}

/**
 * Normalize one listing entry. Returns null for entries without a usable id.
 *
 * Fields read, by source:
 *   - OpenAI:    id, owned_by
 *   - vLLM:      max_model_len
 *   - LLM Hub:   meta_data.{display_name, model_type, max_sequence_length,
 *                max_output_length, input_modalities, end_of_life_date}
 *   - Mistral:   name, description, max_context_length, capabilities, deprecation
 *   - OpenRouter/Together: name/display_name, description, context_length,
 *                architecture.input_modalities, supported_parameters,
 *                top_provider.max_completion_tokens, type
 *   - Groq:      context_window
 *   - Anthropic: display_name
 *   - Google:    name ("models/…"), displayName, description, inputTokenLimit,
 *                outputTokenLimit, supportedGenerationMethods
 */
export function normalizeModelEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const meta = item.meta_data && typeof item.meta_data === 'object' ? item.meta_data : {};

  let id = firstString(item.id);
  if (!id && typeof item.name === 'string' && item.name.startsWith('models/')) {
    id = item.name.slice('models/'.length).trim();
  }
  if (!id) return null;

  const contextWindow = firstTokenCount(
    CONTEXT_WINDOW_MIN,
    CONTEXT_WINDOW_MAX,
    item.max_model_len,
    meta.max_sequence_length,
    item.max_context_length,
    item.context_length,
    item.context_window,
    item.inputTokenLimit
  );
  let maxOutputTokens = firstTokenCount(
    MAX_OUTPUT_TOKENS_MIN,
    Number.MAX_SAFE_INTEGER,
    meta.max_output_length,
    item.outputTokenLimit,
    item.max_output_tokens,
    item.top_provider?.max_completion_tokens
  );
  // A reported output cap as large as the window leaves no room for the
  // prompt — vLLM then rejects every request. Drop it so iHub's own default
  // (bounded by half the window) applies.
  if (maxOutputTokens !== null && contextWindow !== null && maxOutputTokens >= contextWindow) {
    maxOutputTokens = null;
  }
  if (maxOutputTokens !== null) maxOutputTokens = Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS_MAX);

  const name = firstString(meta.display_name, item.display_name, item.displayName, item.name) || id;

  const modalities = [
    ...lowerList(meta.input_modalities),
    ...lowerList(item.architecture?.input_modalities)
  ];
  let supportsVision = null;
  if (modalities.length > 0) supportsVision = modalities.includes('image');
  if (typeof item.capabilities?.vision === 'boolean') supportsVision = item.capabilities.vision;

  let supportsTools = null;
  if (typeof item.capabilities?.function_calling === 'boolean') {
    supportsTools = item.capabilities.function_calling;
  } else if (Array.isArray(item.supported_parameters)) {
    supportsTools = item.supported_parameters.includes('tools');
  }

  const endOfLife = firstString(meta.end_of_life_date, item.deprecation);

  return {
    id,
    name: name === `models/${id}` ? id : name,
    description: firstString(item.description)?.slice(0, 500) || null,
    ownedBy: firstString(item.owned_by),
    type: classifyType(item, meta, id),
    contextWindow,
    maxOutputTokens,
    supportsVision,
    supportsTools,
    endOfLife
  };
}

/**
 * Read a model listing body into normalized entries, sorted by id.
 *
 * Accepts `{ data: [...] }` (OpenAI and compatible servers, Mistral, LLM Hub,
 * Anthropic), `{ models: [...] }` (Google) and a bare array.
 *
 * @param {unknown} body - Parsed JSON
 * @returns {ReturnType<typeof normalizeModelEntry>[]}
 * @throws {ModelDiscoveryError} when the body is not a model listing
 */
export function parseModelsResponse(body) {
  let items = null;
  if (Array.isArray(body)) items = body;
  else if (Array.isArray(body?.data)) items = body.data;
  else if (Array.isArray(body?.models)) items = body.models;
  if (!items) {
    throw new ModelDiscoveryError('invalidResponse', 'The endpoint did not return a model list', {
      details:
        'Expected a JSON object with a "data" or "models" array, as returned by a /models endpoint.'
    });
  }

  const seen = new Set();
  const models = [];
  for (const item of items) {
    const entry = normalizeModelEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(entry);
    if (models.length >= MAX_MODELS) break;
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** Socket-level failures with a dedicated explanation. */
const NETWORK_FAILURES = {
  ECONNREFUSED: ['connectionRefused', 'Connection refused'],
  ENOTFOUND: ['hostNotFound', 'Host not found'],
  EAI_AGAIN: ['hostNotFound', 'Host not found'],
  ECONNRESET: ['networkError', 'Connection reset'],
  ETIMEDOUT: ['timeout', 'Connection timeout'],
  UND_ERR_CONNECT_TIMEOUT: ['timeout', 'Connection timeout']
};

function describeFetchFailure(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || err?.type === 'aborted') {
    return new ModelDiscoveryError('timeout', 'The endpoint did not respond in time', {
      details: `No response within ${DISCOVERY_TIMEOUT_MS / 1000} seconds.`
    });
  }
  const code = String(err?.code || err?.cause?.code || err?.errno || '');
  const [messageKey, message] = NETWORK_FAILURES[code] || ['networkError', 'Network error'];
  return new ModelDiscoveryError(messageKey, message, { details: err?.message });
}

function describeHttpFailure(status, sentKey) {
  if ((status === 401 || status === 403) && !sentKey) {
    return new ModelDiscoveryError('apiKeyRequired', 'The endpoint requires an API key', {
      upstreamStatus: status,
      details: `HTTP ${status}. Enter the API key for this endpoint and load the models again.`
    });
  }
  if (status === 401) {
    return new ModelDiscoveryError('authenticationFailed', 'The endpoint rejected the API key', {
      upstreamStatus: status,
      details: 'HTTP 401. Check the API key, or enter one if the endpoint requires it.'
    });
  }
  if (status === 403) {
    return new ModelDiscoveryError('accessDenied', 'Access denied by the endpoint', {
      upstreamStatus: status,
      details: 'HTTP 403. The API key is not allowed to list models.'
    });
  }
  if (status === 404) {
    return new ModelDiscoveryError('notFound', 'No model list at this URL', {
      upstreamStatus: status,
      details: 'HTTP 404. Check the URL — it usually ends in /v1 or /v1/models.'
    });
  }
  return new ModelDiscoveryError('upstreamError', `The endpoint answered with HTTP ${status}`, {
    upstreamStatus: status
  });
}

function responseTooLarge() {
  return new ModelDiscoveryError('invalidResponse', 'The model list is too large', {
    details: `The response exceeds ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB.`
  });
}

/**
 * Read the listing body as JSON. The fetch is made with node-fetch's `size`
 * option, which aborts the stream once MAX_RESPONSE_BYTES is passed — also
 * when the endpoint sends no `content-length` — and rejects with a `max-size`
 * FetchError; the length checks here cover an injected fetch without it.
 */
async function readJsonBody(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw responseTooLarge();
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    if (err?.type === 'max-size') throw responseTooLarge();
    throw describeFetchFailure(err);
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    throw responseTooLarge();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelDiscoveryError('invalidResponse', 'The endpoint did not return JSON', {
      details: 'Check that the URL points at the API and not at a web page.'
    });
  }
}

/**
 * Fetch and normalize the model listing behind `url`.
 *
 * The call goes through `httpFetch`, so the platform's proxy and SSL settings
 * apply exactly as they do for the imported models later. Private and
 * loopback hosts are allowed on purpose: self-hosted vLLM and LM Studio
 * servers live there, and only admins can reach this. Redirects are not
 * followed, so a key is never sent on to a host the admin did not enter.
 *
 * @param {Object} params
 * @param {string} params.url - URL entered by the admin
 * @param {string} [params.provider='openai'] - One of {@link DISCOVERY_PROVIDERS}
 * @param {string} [params.apiKey] - Optional key; omitted from the call when empty
 * @param {Object} [deps]
 * @param {typeof httpFetch} [deps.fetch] - Injected for tests
 * @returns {Promise<{ provider: string, modelsUrl: string, baseUrl: string,
 *   models: Array<ReturnType<typeof normalizeModelEntry> & { url: string }> }>}
 * @throws {ModelDiscoveryError}
 */
export async function discoverModels({ url, provider = 'openai', apiKey } = {}, deps = {}) {
  const fetchImpl = deps.fetch || httpFetch;
  if (!DISCOVERY_PROVIDERS.includes(provider)) {
    throw new ModelDiscoveryError(
      'unsupportedProvider',
      `Model import does not support provider "${provider}"`,
      { status: 400 }
    );
  }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const { modelsUrl, baseUrl } = resolveModelsEndpoint(url, provider);
  // Google and Anthropic page their listings; ask for everything at once.
  const requestUrl =
    provider === 'google'
      ? `${modelsUrl}?pageSize=1000`
      : provider === 'anthropic'
        ? `${modelsUrl}?limit=1000`
        : modelsUrl;

  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: 'GET',
      headers: buildDiscoveryHeaders(provider, key),
      redirect: 'manual',
      // node-fetch stops reading the body past this many bytes.
      size: MAX_RESPONSE_BYTES,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    });
  } catch (err) {
    logger.warn('Model endpoint discovery failed', {
      component: 'ModelEndpointDiscovery',
      url: redactUrlSecrets(modelsUrl),
      provider,
      error: err?.message,
      code: err?.code || err?.cause?.code
    });
    throw describeFetchFailure(err);
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers?.get?.('location');
    throw new ModelDiscoveryError('redirected', 'The endpoint redirected the request', {
      upstreamStatus: response.status,
      details: location
        ? `It points to ${redactUrlSecrets(location)}. Enter that URL instead.`
        : `HTTP ${response.status}.`
    });
  }
  if (!response.ok) {
    logger.warn('Model endpoint discovery answered with an error', {
      component: 'ModelEndpointDiscovery',
      url: redactUrlSecrets(modelsUrl),
      provider,
      status: response.status
    });
    throw describeHttpFailure(response.status, Boolean(key));
  }

  const models = parseModelsResponse(await readJsonBody(response)).map(entry => ({
    ...entry,
    url: buildInferenceUrl(provider, baseUrl, entry.id)
  }));

  logger.info('Model endpoint discovered', {
    component: 'ModelEndpointDiscovery',
    url: redactUrlSecrets(modelsUrl),
    provider,
    models: models.length
  });

  return { provider, modelsUrl, baseUrl, models };
}

/**
 * Comparable form of an inference URL: lower-case origin, no trailing slash.
 * Used to tell the admin which listed models are already configured.
 */
export function comparableUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${stripTrailingSlashes(parsed.pathname)}`.toLowerCase();
  } catch {
    return stripTrailingSlashes(url.trim()).toLowerCase();
  }
}
