// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * LLM provider entries (`config/providers.json`) and the models linked to them.
 * Shared by the server (API key lookup, admin routes) and the admin UI.
 *
 * A model's `provider` field is its API type — the adapter that speaks to the
 * endpoint (`openai`, `local`, `anthropic`, …). The provider entry that holds
 * its API key is found by `model.providerId`, falling back to `model.provider`
 * itself: the built-in entries (`openai`, `anthropic`, …) are named after
 * their API type, so existing models need no link.
 *
 * A custom LLM provider — a gateway such as T-Systems AI Foundation Services
 * (LLM Hub) — declares the API type its endpoint speaks in `apiType`, and its
 * models carry `providerId`. One key on the provider then serves all of them.
 */

/**
 * Provider entries named after an API type. They are never deleted, and their
 * API type is their id.
 */
export const BUILT_IN_LLM_PROVIDERS = Object.freeze([
  'openai',
  'anthropic',
  'google',
  'mistral',
  'local',
  'bedrock'
]);

/** API types a custom LLM provider can declare (the chat adapters with an HTTP endpoint). */
export const CUSTOM_PROVIDER_API_TYPES = Object.freeze([
  'openai',
  'local',
  'mistral',
  'openai-responses',
  'anthropic',
  'google'
]);

/**
 * Gateway kinds a custom LLM provider can declare in `gateway`. The
 * iFinder Model Gateway (ifinder/model-gateway in the iFinder repo) is an
 * OpenAI-compatible reverse proxy in front of vLLM, Azure OpenAI and Mistral
 * deployments. It lists its models on `/v1/gateway/models` — with the
 * endpoints and modalities each serves — and serves inference under
 * `/v1/gateway/proxy/`, so the plain "…/models" and "…/chat/completions"
 * conventions of other endpoints do not apply to it.
 */
export const IFINDER_GATEWAY = 'ifinder-model-gateway';

/** Values the `gateway` field of a provider entry accepts. */
export const GATEWAY_KINDS = Object.freeze([IFINDER_GATEWAY]);

/**
 * API types a gateway provider can declare: the dialect its OpenAI-typed
 * models are called with. `openai` for a gateway in front of hosted models,
 * `local` (the vLLM adapter) when the backends are mostly self-hosted vLLM.
 * Models the gateway reports as Mistral dialect always use the `mistral`
 * adapter, whatever the provider declares.
 */
export const GATEWAY_API_TYPES = Object.freeze(['openai', 'local']);

/**
 * API types whose speech-to-text models iHub can run: they speak the OpenAI
 * audio API (`/audio/transcriptions`), served by
 * server/transcription/openaiTranscribeProvider.js. Model import turns a
 * listed Whisper-style model of these types into a transcription model.
 */
export const TRANSCRIPTION_API_TYPES = Object.freeze(['openai', 'local']);

/**
 * Every value a model's `provider` (API type) can take. Mirrors the `provider`
 * enum of server/validators/modelConfigSchema.js; a test keeps them equal.
 *
 * None of them can be the ID of a new provider entry: a model without
 * `providerId` takes its key from the entry named after its API type, so an
 * entry called `openai-responses` would silently pick up every unlinked
 * Responses-API model.
 */
export const MODEL_API_TYPES = Object.freeze([
  'openai',
  'openai-responses',
  'anthropic',
  'google',
  'mistral',
  'local',
  'iassistant-conversation',
  'bedrock',
  'vllm-realtime',
  'google-live',
  'google-transcribe'
]);

/**
 * Speech backends a transcription model may run on instead of the adapter of
 * its provider's API type: Gemini's Live API and its Files API transcription
 * (server/transcription/), reached with the key of a Google provider.
 */
const SPEECH_BACKENDS = Object.freeze({
  google: Object.freeze(['google-live', 'google-transcribe'])
});

/**
 * The `provider` (API type) of a model linked to a provider entry of API type
 * `apiType`: that API type, except for a transcription model on one of its
 * speech backends, which keeps the backend.
 *
 * @param {string} apiType - API type of the provider entry
 * @param {Object} model - Model config (`provider`, `modelType`)
 * @returns {string}
 */
export function linkedModelProvider(apiType, model) {
  return model?.modelType === 'transcription' && SPEECH_BACKENDS[apiType]?.includes(model.provider)
    ? model.provider
    : apiType;
}

/**
 * Adapters a model linked to a gateway provider may use: the OpenAI-compatible
 * ones, the Mistral dialect, and the vLLM realtime speech backend. The
 * gateway fronts backends of different dialects, so unlike a model of any
 * other custom provider, such a model keeps its own `provider`.
 */
export const GATEWAY_MODEL_PROVIDERS = Object.freeze([
  'openai',
  'local',
  'mistral',
  'vllm-realtime'
]);

/**
 * The `provider` of a model linked to a gateway provider with API type
 * `apiType`: the model's own adapter when it is one a gateway offers, else the
 * provider's API type.
 *
 * @param {string} apiType - API type of the gateway provider
 * @param {Object} model - Model config (`provider`)
 * @returns {string}
 */
export function gatewayModelProvider(apiType, model) {
  return GATEWAY_MODEL_PROVIDERS.includes(model?.provider) ? model.provider : apiType;
}

/** True for an ID a new provider entry cannot take (see MODEL_API_TYPES). */
export function isReservedProviderId(id) {
  return MODEL_API_TYPES.includes(id);
}

/** True for an entry an admin created for an LLM gateway of their own. */
export function isCustomLlmProvider(provider) {
  return Boolean(
    provider &&
    provider.category === 'llm' &&
    typeof provider.apiType === 'string' &&
    !BUILT_IN_LLM_PROVIDERS.includes(provider.id)
  );
}

/** True for a custom LLM provider that points at an iFinder Model Gateway. */
export function isGatewayProvider(provider) {
  return Boolean(provider && provider.gateway === IFINDER_GATEWAY && isCustomLlmProvider(provider));
}

/**
 * Whether iHub can compare the provider's model listing with the models imported
 * from it ("Sync models"): an iFinder Model Gateway, Google or Anthropic. Their
 * listing names each model with what the sync compares (context window, whether it
 * still exists) or what an import fills in (the provider's EU AI Act marking). The
 * listing is read from the saved provider entry on the server.
 */
export function supportsModelSync(provider) {
  return (
    isGatewayProvider(provider) || ['google', 'anthropic'].includes(getProviderApiType(provider))
  );
}

/**
 * The API type (adapter) of a provider entry: its `apiType` for a custom LLM
 * provider, its id for a built-in one, null for anything else.
 */
export function getProviderApiType(provider) {
  if (!provider) return null;
  if (isCustomLlmProvider(provider)) return provider.apiType;
  if (BUILT_IN_LLM_PROVIDERS.includes(provider.id)) return provider.id;
  return null;
}

/**
 * Hosts of the vendors' own endpoints. A model that calls one of them cannot
 * run without a key, so a missing key there is a configuration error.
 */
const KEY_REQUIRED_HOSTS = Object.freeze(['api.openai.com']);

/**
 * Whether a model may be called without an API key.
 *
 * - `local` (vLLM, LM Studio, Jan.ai, Ollama): such servers usually have no
 *   authentication, so a missing key is the normal case.
 * - `openai` pointed at a server of its own (a gateway or an OpenAI-compatible
 *   server at a custom `url`) and not linked to a custom provider entry: the
 *   same kind of endpoint, reached through the OpenAI API type. Linked models
 *   keep their key requirement — that provider exists to hold one.
 * - A model linked to an iFinder Model Gateway provider, whatever its dialect:
 *   a gateway without projects is open, so no key is the normal case there.
 *   One that does need a key answers 401 when the model is called.
 *
 * This only decides what happens when no key is found anywhere; a configured
 * key is always sent.
 *
 * @param {Object} model - Model config (`provider`, `providerId`, `url`)
 * @param {Object} [providerEntry] - The provider entry the model is linked to, when it has one
 * @returns {boolean}
 */
export function allowsMissingApiKey(model, providerEntry) {
  if (!model) return false;
  if (isGatewayProvider(providerEntry)) return true;
  if (model.provider === 'local') return true;
  if (model.provider !== 'openai' || model.providerId || typeof model.url !== 'string') {
    return false;
  }
  try {
    const { hostname } = new URL(model.url);
    return Boolean(hostname) && !KEY_REQUIRED_HOSTS.includes(hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Id of the provider entry a model takes its API key from. */
export function getModelProviderId(model) {
  return model?.providerId || model?.provider || null;
}

/**
 * Transport ceilings, in milliseconds, that a provider entry, a model and the
 * installation (`llm` in platform.json) can each set. Most specific wins:
 * model, provider entry, installation, environment, built-in default.
 */
export const LLM_TIMEOUT_KEYS = Object.freeze(['connectTimeoutMs', 'streamIdleTimeoutMs']);

/** Largest ceiling an admin can set (5 minutes); `0` disables the ceiling. */
export const LLM_TIMEOUT_MAX_MS = 300000;

/** The provider entry a model takes its API key and transport ceilings from. */
export function findModelProvider(model, providers) {
  const id = getModelProviderId(model);
  return id ? (providers || []).find(provider => provider.id === id) : undefined;
}

/** Models whose API key comes from the provider entry `providerId`. */
export function getLinkedModels(providerId, models) {
  return (models || []).filter(model => getModelProviderId(model) === providerId);
}

/**
 * Environment variable a provider's key can be set in: `LLMHUB_API_KEY` for a
 * provider with id `llmhub`, `T_SYSTEMS_API_KEY` for `t-systems`.
 */
export function providerEnvKeyName(providerId) {
  return `${String(providerId)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}
