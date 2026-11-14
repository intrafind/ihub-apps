// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
import { ServiceError } from '../utils/ServiceError.js';
import logger from '../utils/logger.js';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  MAX_OUTPUT_TOKENS_MAX,
  MAX_OUTPUT_TOKENS_MIN
} from '../../shared/validationPatterns.js';
import {
  CUSTOM_PROVIDER_API_TYPES,
  GATEWAY_API_TYPES,
  IFINDER_GATEWAY,
  TRANSCRIPTION_API_TYPES
} from '../../shared/llmProviders.js';
import { providerMarkingFacts } from './provenance/providerMarking.js';

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
export const MAX_MODELS = 5000;

/**
 * Error raised for anything the admin has to fix: a bad URL, an endpoint that
 * rejects the key, a body that is not a model listing. `messageKey` is the
 * stable identifier the client translates (`details.messageKey`, with the
 * remediation text in `details.remediation`); `status` is the HTTP status the
 * route answers with.
 */
export class ModelDiscoveryError extends ServiceError {
  constructor(messageKey, message, { status = 502, details, upstreamStatus } = {}) {
    super('DISCOVERY_FAILED', message, {
      status,
      details: {
        messageKey,
        ...(details === undefined ? {} : { remediation: details }),
        ...(upstreamStatus === undefined ? {} : { upstreamStatus })
      }
    });
    this.name = 'ModelDiscoveryError';
    this.messageKey = messageKey;
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
 * Whether `hostname` is an Azure OpenAI / Azure AI Foundry endpoint. These
 * serve the OpenAI API under `/openai`, address models by *deployment name*,
 * and list the models a resource offers (the catalog), not its deployments.
 */
export function isAzureOpenAiHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host.endsWith('.openai.azure.com') ||
    host.endsWith('.cognitiveservices.azure.com') ||
    host.endsWith('.services.ai.azure.com')
  );
}

/**
 * Parse the URL an admin entered: http(s) only, no credentials in it.
 *
 * @param {string} input
 * @returns {URL}
 * @throws {ModelDiscoveryError}
 */
function parseHttpUrl(input) {
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
  return parsed;
}

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
 * Azure OpenAI hosts: whatever the path under `/openai` (`…/openai/responses`,
 * `…/openai/deployments/x/chat/completions`), the listing is `/openai/v1/models`,
 * the only listing the key can call without an `api-version`. A pasted
 * `api-version` is returned as `azureApiVersion`, because it names the inference
 * URL the admin wants models called on (see {@link buildInferenceUrl}).
 *
 * @param {string} input - URL entered by the admin
 * @param {string} provider - One of {@link DISCOVERY_PROVIDERS}
 * @returns {{ modelsUrl: string, baseUrl: string, azure: boolean, azureApiVersion?: string }}
 * @throws {ModelDiscoveryError} for anything that is not an http(s) URL
 */
export function resolveModelsEndpoint(input, provider) {
  const parsed = parseHttpUrl(input);

  let path = stripTrailingSlashes(parsed.pathname);
  const azure = provider !== 'google' && isAzureOpenAiHost(parsed.hostname);

  if (azure) {
    path = '/openai/v1/models';
  } else if (provider === 'google') {
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
  const result = {
    modelsUrl: `${origin}${path}`,
    baseUrl: `${origin}${path.slice(0, -'/models'.length)}`,
    azure
  };
  const apiVersion = azure ? parsed.searchParams.get('api-version') : null;
  if (apiVersion) result.azureApiVersion = apiVersion;
  return result;
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
 * @param {string} [type] - The model's type from the listing
 * @param {Object} [options]
 * @param {string} [options.azureApiVersion] - `api-version` the admin pasted for an
 *   Azure endpoint. With the Responses API the model is then called on
 *   `…/openai/responses?api-version=…` rather than the versionless `…/openai/v1/responses`.
 * @returns {string}
 */
export function buildInferenceUrl(provider, baseUrl, modelId, type, options = {}) {
  // A speech-to-text model of an OpenAI-compatible endpoint is called on its
  // audio API, where iHub's transcription provider sends recordings.
  if (type === 'transcription' && TRANSCRIPTION_API_TYPES.includes(provider)) {
    return `${baseUrl}/audio/transcriptions`;
  }
  switch (provider) {
    case 'openai-responses':
      if (options.azureApiVersion) {
        const root = baseUrl.replace(/\/v1$/, '');
        return `${root}/responses?api-version=${encodeURIComponent(options.azureApiVersion)}`;
      }
      return `${baseUrl}/responses`;
    case 'anthropic':
      return `${baseUrl}/messages`;
    case 'google':
      return `${baseUrl}/models/${encodeURIComponent(modelId)}:streamGenerateContent`;
    default:
      return `${baseUrl}/chat/completions`;
  }
}

/**
 * `baseUrl` with its scheme turned into the WebSocket one (`https` → `wss`).
 */
function toWebSocketUrl(baseUrl) {
  return baseUrl.replace(/^http(s?):/i, (_m, secure) => (secure ? 'wss:' : 'ws:'));
}

/**
 * Split a Google API base into the root it hangs off and its API version:
 * `https://gw.example/google/v1beta` → `https://gw.example/google` and `v1beta`.
 * A gateway's path prefix stays on the root.
 */
function splitGoogleBase(baseUrl) {
  // Split at the last slash rather than with `/^(.*)\/(v…)$/`, which
  // backtracks super-linearly.
  const slash = baseUrl.lastIndexOf('/');
  const last = baseUrl.slice(slash + 1);
  // `v1`, `v1beta`, `v1alpha`; letters only after the digits, so nothing overlaps.
  return slash > 0 && /^v\d+[a-z]*$/i.test(last)
    ? { root: baseUrl.slice(0, slash), version: last }
    : { root: baseUrl, version: 'v1beta' };
}

/**
 * Gemini's Live API endpoint under the root of `baseUrl`, in the API version
 * the base names (`…/v1beta` → `…v1beta.GenerativeService.BidiGenerateContent`).
 */
function googleLiveUrl(baseUrl) {
  const { root, version } = splitGoogleBase(baseUrl);
  return `${toWebSocketUrl(root)}/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent`;
}

/**
 * How iHub runs a speech model listed by an endpoint of API type `provider`:
 * the model `provider` (the speech backend in server/transcription/ or
 * server/tts/) and the URL it calls. Null when iHub has no backend for it —
 * Mistral's batch transcription, OpenAI's text-to-speech.
 *
 * @param {string} provider - API type of the endpoint
 * @param {string} baseUrl - API base returned by {@link resolveModelsEndpoint}
 * @param {{ id: string, type: string, realtime?: boolean }} entry - Normalized entry
 * @returns {{ modelType: 'transcription'|'tts', backend: string, url: string }|null}
 */
export function buildSpeechTarget(provider, baseUrl, entry) {
  if (entry.type === 'transcription') return transcriptionTarget(provider, baseUrl, entry);
  if (entry.type === 'tts') return ttsTarget(provider, baseUrl, entry);
  return null;
}

/** {@link buildSpeechTarget} for a speech-to-text model. */
function transcriptionTarget(provider, baseUrl, entry) {
  if (TRANSCRIPTION_API_TYPES.includes(provider)) {
    return {
      modelType: 'transcription',
      backend: provider,
      url: buildInferenceUrl(provider, baseUrl, entry.id, entry.type)
    };
  }
  if (provider === 'google') {
    // Live (WebSocket) or file transcription through the Gemini Files API.
    return entry.realtime
      ? { modelType: 'transcription', backend: 'google-live', url: googleLiveUrl(baseUrl) }
      : {
          modelType: 'transcription',
          backend: 'google-transcribe',
          // The API root: the backend adds the version to each call.
          url: splitGoogleBase(baseUrl).root
        };
  }
  if (provider === 'mistral' && entry.realtime) {
    return {
      modelType: 'transcription',
      backend: 'mistral',
      url: `${toWebSocketUrl(baseUrl)}/audio/transcriptions/realtime`
    };
  }
  return null;
}

/** {@link buildSpeechTarget} for a text-to-speech model. */
function ttsTarget(provider, baseUrl, entry) {
  if (provider === 'google') {
    return {
      modelType: 'tts',
      backend: 'google',
      url: buildInferenceUrl(provider, baseUrl, entry.id)
    };
  }
  if (provider === 'mistral') {
    return { modelType: 'tts', backend: 'mistral', url: `${baseUrl}/audio/speech` };
  }
  return null;
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
  tts: 'tts',
  // Speech-to-text has a type of its own: it can be imported as a
  // transcription model (LLM Hub declares Whisper as "STT").
  stt: 'transcription',
  asr: 'transcription',
  transcribe: 'transcription',
  transcription: 'transcription'
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
  if (/whisper|transcri/.test(s)) return 'transcription';
  if (/(^|[-_/])tts([-_]|$)/.test(s)) return 'tts';
  if (/speech|realtime/.test(s)) return 'audio';
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

  // OpenRouter: a model that cannot answer in text is an image or audio generator.
  const outputs = lowerList(item.architecture?.output_modalities);
  if (outputs.length > 0 && !outputs.includes('text')) {
    if (outputs.includes('image')) return 'image';
    if (outputs.includes('audio')) return 'audio';
    return 'other';
  }

  const methods = item.supportedGenerationMethods;
  if (Array.isArray(methods)) {
    // Google. Its speech models answer `generateContent` like chat models
    // (text-to-speech, file transcription) or only `bidiGenerateContent` (live
    // transcription): only their ids tell them apart.
    const speech = typeFromId(id);
    if (speech === 'transcription' || speech === 'tts') return speech;
    if (methods.includes('generateContent')) return 'chat';
    if (methods.includes('embedContent') || methods.includes('embedText')) return 'embedding';
    if (methods.includes('bidiGenerateContent')) return 'audio';
    if (methods.includes('predict')) return 'image';
    return 'other';
  }

  return typeFromId(id);
}

/**
 * Whether a speech model streams over a WebSocket rather than taking a file:
 * Google's Live API models (`bidiGenerateContent` only), Mistral's
 * `…-realtime` transcription.
 */
function isRealtimeSpeech(item, id, type) {
  if (type !== 'transcription' && type !== 'tts') return false;
  if (/(^|[-_])(live|realtime)([-_]|$)/i.test(id)) return true;
  const methods = Array.isArray(item.supportedGenerationMethods)
    ? item.supportedGenerationMethods
    : [];
  return methods.includes('bidiGenerateContent') && !methods.includes('generateContent');
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
 *                architecture.{input_modalities, output_modalities}, supported_parameters,
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

  const type = classifyType(item, meta, id);
  const realtime = isRealtimeSpeech(item, id, type);

  return {
    id,
    name: name === `models/${id}` ? id : name,
    description: firstString(item.description)?.slice(0, 500) || null,
    ownedBy: firstString(item.owned_by),
    type,
    ...(realtime ? { realtime: true } : {}),
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
  return collectEntries(body, normalizeModelEntry);
}

/**
 * The entries of a listing body: `{ data: [...] }` (OpenAI-compatible,
 * Mistral, LLM Hub, Anthropic, the iFinder Model Gateway), `{ models: [...] }`
 * (Google) or a bare array.
 *
 * @throws {ModelDiscoveryError} when the body is not a model listing
 */
function listingItems(body) {
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
  return items;
}

/** Normalize every entry of a listing with `normalize`; drop duplicates; sort by id. */
function collectEntries(body, normalize) {
  const seen = new Set();
  const models = [];
  for (const item of listingItems(body)) {
    const entry = normalize(item);
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

/**
 * Whether an HTTP 400 is Google's answer to a wrong key: it reports
 * `API_KEY_INVALID` in the error body instead of answering 401.
 */
async function isInvalidKeyAnswer(response) {
  if (response.status !== 400) return false;
  try {
    return (await response.text()).includes('API_KEY_INVALID');
  } catch {
    return false;
  }
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
 * GET a listing and read its JSON body. Redirects are not followed and every
 * failure becomes a {@link ModelDiscoveryError} the admin can act on.
 */
async function fetchListingBody({ fetchImpl, requestUrl, headers, modelsUrl, provider, key }) {
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: 'GET',
      headers,
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
    if (key && (await isInvalidKeyAnswer(response))) {
      throw new ModelDiscoveryError('authenticationFailed', 'The endpoint rejected the API key', {
        upstreamStatus: response.status,
        details: 'HTTP 400 (API_KEY_INVALID). Check the API key.'
      });
    }
    throw describeHttpFailure(response.status, Boolean(key));
  }
  return readJsonBody(response);
}

// ---------------------------------------------------------------------------
// iFinder Model Gateway
// ---------------------------------------------------------------------------

/** Path every Model Gateway route hangs off (`/v1/gateway/models`, `/v1/gateway/proxy/…`). */
const GATEWAY_PATH = /\/v1\/gateway(?:\/|$)/i;

/**
 * The gateway's listing URL and the base its proxy routes hang off, from
 * whatever URL the admin pasted: the gateway root (`https://gw:9614`), the
 * `/v1/gateway` base, the listing, or a proxy URL. A path prefix in front of
 * `/v1/gateway` (a reverse proxy mounting the gateway) is kept.
 *
 * Query string and fragment are dropped, as for every other endpoint.
 *
 * @param {string} input
 * @returns {{ modelsUrl: string, baseUrl: string, proxyUrl: string, azure: false }}
 * @throws {ModelDiscoveryError} for anything that is not an http(s) URL
 */
export function resolveGatewayEndpoint(input) {
  const parsed = parseHttpUrl(input);
  let path = stripTrailingSlashes(parsed.pathname);
  const match = GATEWAY_PATH.exec(path);
  if (match) path = path.slice(0, match.index);
  else if (path.toLowerCase().endsWith('/v1')) path = path.slice(0, -'/v1'.length);
  const root = `${parsed.origin}${path}`;
  return {
    modelsUrl: `${root}/v1/gateway/models`,
    baseUrl: `${root}/v1/gateway`,
    proxyUrl: `${root}/v1/gateway/proxy`,
    azure: false
  };
}

/** Upper-cased strings of a list field; anything else is an empty list. */
function upperList(value) {
  return Array.isArray(value)
    ? value.filter(v => typeof v === 'string').map(v => v.trim().toUpperCase())
    : [];
}

/**
 * Normalize one entry of the gateway's `GET /v1/gateway/models`:
 *
 *   { id, object, api_type: OPENAI | MISTRAL | AZURE_OPENAI, max_model_len,
 *     endpoints: [CHAT | EMBEDDING | NER | REALTIME], modalities: [VISION] }
 *
 * The gateway probes its backends, so `endpoints` is authoritative for what a
 * model is — nothing is guessed from the id. A model serving several
 * endpoints is imported for the first of chat, embedding, realtime.
 *
 * The listing says nothing about tool calling: the gateway does not support it
 * yet, so chat models are reported without tool support.
 *
 * @param {Object} item
 * @returns {Object|null} Null for an entry without an id
 */
export function normalizeGatewayEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const id = firstString(item.id);
  if (!id) return null;

  const endpoints = upperList(item.endpoints);
  const modalities = upperList(item.modalities);
  const apiType = firstString(item.api_type)?.toUpperCase() || 'OPENAI';

  let type = 'other';
  if (endpoints.includes('CHAT')) type = 'chat';
  else if (endpoints.includes('EMBEDDING')) type = 'embedding';
  else if (endpoints.includes('REALTIME')) type = 'transcription';
  const chat = type === 'chat';

  return {
    id,
    name: id,
    description: null,
    ownedBy: null,
    type,
    ...(type === 'transcription' ? { realtime: true } : {}),
    contextWindow: chat
      ? firstTokenCount(CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, item.max_model_len)
      : null,
    maxOutputTokens: null,
    supportsVision: chat ? modalities.includes('VISION') : null,
    // Not offered by the gateway yet; revisit when its listing reports it.
    supportsTools: chat ? false : null,
    endOfLife: null,
    gateway: { apiType, endpoints }
  };
}

/** Read the gateway's listing body into normalized entries, sorted by id. */
export function parseGatewayModelsResponse(body) {
  return collectEntries(body, normalizeGatewayEntry);
}

/**
 * How a model of the gateway is imported: the URL it is called on (always
 * through the gateway's auto-select `proxy` routes, which pick a healthy
 * deployment from the model id), the adapter that speaks its dialect and, for
 * speech, the backend that runs it.
 *
 * - `OPENAI` and `AZURE_OPENAI` models use `apiType` (the provider's: `openai`
 *   or `local`); `MISTRAL` models use the `mistral` adapter.
 * - iHub has no embedding model type and cannot run NER (`/pooling`), so those
 *   are listed but `unsupported`.
 * - Realtime speech is dialect-specific. vLLM takes `model` as a query
 *   parameter of the URL (the gateway's auto-select needs it there); the
 *   Mistral backend adds it itself. Azure's realtime handshake is unverified
 *   in the gateway, so it is `unsupported`.
 *
 * @param {string} proxyUrl - `…/v1/gateway/proxy`
 * @param {string} apiType - The provider's API type, `openai` or `local`
 * @param {ReturnType<typeof normalizeGatewayEntry>} entry
 * @returns {Object} Fields merged into the entry
 */
export function buildGatewayTarget(proxyUrl, apiType, entry) {
  const dialect = entry.gateway.apiType;
  const modelProvider = dialect === 'MISTRAL' ? 'mistral' : apiType;
  switch (entry.type) {
    case 'chat':
      return { url: `${proxyUrl}/chat/completions`, modelProvider };
    case 'embedding':
      return { url: `${proxyUrl}/embeddings`, modelProvider, unsupported: true };
    case 'transcription': {
      const realtime = `${toWebSocketUrl(proxyUrl)}/realtime`;
      if (dialect === 'MISTRAL') {
        return { modelType: 'transcription', backend: 'mistral', url: realtime };
      }
      if (dialect === 'OPENAI') {
        return {
          modelType: 'transcription',
          backend: 'vllm-realtime',
          url: `${realtime}?model=${encodeURIComponent(entry.id)}`
        };
      }
      return { url: realtime, modelProvider, unsupported: true };
    }
    default:
      return { url: `${proxyUrl}/chat/completions`, modelProvider, unsupported: true };
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
 * @param {string} [params.gateway] - `ifinder-model-gateway` when the endpoint is an iFinder
 *   Model Gateway: its own listing and proxy routes apply, and `provider` is then the
 *   dialect of its OpenAI models (`openai` or `local`)
 * @param {Object} [deps]
 * @param {typeof httpFetch} [deps.fetch] - Injected for tests
 * @returns {Promise<{ provider: string, modelsUrl: string, baseUrl: string, azure: boolean,
 *   gateway?: string,
 *   models: Array<ReturnType<typeof normalizeModelEntry> & { url: string,
 *     modelType?: 'transcription'|'tts', backend?: string, modelProvider?: string,
 *     unsupported?: true }> }>}
 *   A speech model carries the `modelType` and the `backend` (model `provider`)
 *   it is imported with, or `unsupported` when iHub cannot run it. A gateway
 *   model carries the adapter (`modelProvider`) of its dialect.
 * @throws {ModelDiscoveryError}
 */
export async function discoverModels(
  { url, provider = 'openai', apiKey, gateway } = {},
  deps = {}
) {
  const fetchImpl = deps.fetch || httpFetch;
  // An unset or empty `gateway` is an ordinary endpoint.
  if (gateway) {
    return discoverGatewayModels({ url, provider, apiKey, gateway }, fetchImpl);
  }
  if (!DISCOVERY_PROVIDERS.includes(provider)) {
    throw new ModelDiscoveryError(
      'unsupportedProvider',
      `Model import does not support provider "${provider}"`,
      { status: 400 }
    );
  }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const { modelsUrl, baseUrl, azure, azureApiVersion } = resolveModelsEndpoint(url, provider);
  // Google and Anthropic page their listings; ask for everything at once.
  const requestUrl =
    provider === 'google'
      ? `${modelsUrl}?pageSize=1000`
      : provider === 'anthropic'
        ? `${modelsUrl}?limit=1000`
        : modelsUrl;

  const body = await fetchListingBody({
    fetchImpl,
    requestUrl,
    headers: buildDiscoveryHeaders(provider, key),
    modelsUrl,
    provider,
    key
  });

  const models = parseModelsResponse(body).map(entry => {
    if (entry.type !== 'transcription' && entry.type !== 'tts') {
      return {
        ...entry,
        // What the provider says about marking this model's output (EU AI Act
        // Art. 50(2)); the import and the model sync copy it into the config.
        ...providerMarkingFacts(provider, entry, { baseUrl }),
        url: buildInferenceUrl(provider, baseUrl, entry.id, entry.type, { azureApiVersion })
      };
    }
    // A speech model is imported for the backend that runs it, or not at all:
    // as a chat model it could never answer.
    const speech = buildSpeechTarget(provider, baseUrl, entry);
    return speech
      ? { ...entry, ...speech }
      : { ...entry, url: buildInferenceUrl(provider, baseUrl, entry.id), unsupported: true };
  });

  logger.info('Model endpoint discovered', {
    component: 'ModelEndpointDiscovery',
    url: redactUrlSecrets(modelsUrl),
    provider,
    models: models.length
  });

  return { provider, modelsUrl, baseUrl, azure, models };
}

/** {@link discoverModels} for an iFinder Model Gateway. */
async function discoverGatewayModels({ url, provider, apiKey, gateway }, fetchImpl) {
  if (gateway !== IFINDER_GATEWAY) {
    throw new ModelDiscoveryError('unsupportedProvider', `Unknown gateway "${gateway}"`, {
      status: 400
    });
  }
  if (!GATEWAY_API_TYPES.includes(provider)) {
    throw new ModelDiscoveryError(
      'unsupportedProvider',
      `A model gateway provider must use the API type ${GATEWAY_API_TYPES.join(' or ')}`,
      { status: 400 }
    );
  }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const { modelsUrl, baseUrl, proxyUrl, azure } = resolveGatewayEndpoint(url);

  // The gateway authenticates with a project API key as a Bearer token. It is
  // optional: a gateway without projects is open (a 401 then says "key needed").
  const body = await fetchListingBody({
    fetchImpl,
    requestUrl: modelsUrl,
    headers: buildDiscoveryHeaders('openai', key),
    modelsUrl,
    provider: gateway,
    key
  });

  const models = parseGatewayModelsResponse(body).map(entry => ({
    ...entry,
    ...buildGatewayTarget(proxyUrl, provider, entry)
  }));

  logger.info('Model gateway discovered', {
    component: 'ModelEndpointDiscovery',
    url: redactUrlSecrets(modelsUrl),
    gateway,
    models: models.length
  });

  return { provider, modelsUrl, baseUrl, azure, gateway, models };
}

/**
 * Comparable form of an inference URL: no trailing slash, and the origin in
 * the lower case `URL` gives it. The path keeps its case — paths are
 * case-sensitive. Used to tell the admin which listed models are already
 * configured.
 */
export function comparableUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${stripTrailingSlashes(parsed.pathname)}`;
  } catch {
    return stripTrailingSlashes(url.trim());
  }
}
