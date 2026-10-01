/**
 * Helpers for the admin "Import from URL" dialog (ModelImportDialog).
 *
 * `POST /admin/models/_discover` returns the models an endpoint lists, already
 * normalized; these helpers turn the admin's selection into model configs for
 * `POST /admin/models`, and a new provider into the entry for
 * `POST /admin/providers`. Imported models carry no API key of their own: they
 * are linked to the provider, which holds it. Kept free of React so they can
 * be unit tested.
 */

import {
  CUSTOM_PROVIDER_API_TYPES,
  getProviderApiType
} from '../../../../../shared/llmProviders.js';

/** Same rule as the `id` field of the model and provider schemas. */
const ID_PATTERN = /^[a-z0-9._-]+$/;

/** English labels of the API types, used as i18n fallbacks. */
const API_TYPE_LABELS = {
  openai: 'OpenAI-compatible (OpenAI, LLM Hub, LM Studio, …)',
  local: 'vLLM / self-hosted (local)',
  mistral: 'Mistral',
  'openai-responses': 'OpenAI Responses API',
  anthropic: 'Anthropic',
  google: 'Google Gemini'
};

export function apiTypeLabel(t, apiType) {
  return t(`admin.providers.apiTypes.${apiType}`, API_TYPE_LABELS[apiType] || apiType);
}

/**
 * Turn free text into an id: lower-case, every run of characters outside
 * `[a-z0-9._-]` collapsed into one hyphen (`Qwen/Qwen3-8B` → `qwen-qwen3-8b`).
 *
 * @param {string} text
 * @returns {string} Empty when nothing usable is left
 */
export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
}

/**
 * Suggest an iHub model id for a remote model id, with the optional prefix in
 * front (`llmhub-` + `gpt-oss-120b`).
 */
export function suggestModelId(remoteId, prefix = '') {
  const slug = slugify(remoteId);
  if (!slug) return '';
  const cleanPrefix = String(prefix || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return `${cleanPrefix}${slug}`;
}

export function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && ID_PATTERN.test(id);
}

/**
 * Why each selected row's id cannot be created, if it cannot.
 *
 * @param {Array<{ key: string, id: string }>} selected - Selected rows with their target ids
 * @param {Iterable<string>} existingIds - Ids of the models already configured
 * @returns {Record<string, 'invalid'|'exists'|'duplicate'>} Keyed by row key; rows without a problem are absent
 */
export function findIdProblems(selected, existingIds) {
  const existing = new Set(existingIds);
  const counts = new Map();
  for (const row of selected) counts.set(row.id, (counts.get(row.id) || 0) + 1);

  const problems = {};
  for (const row of selected) {
    if (!isValidId(row.id)) problems[row.key] = 'invalid';
    else if (existing.has(row.id)) problems[row.key] = 'exists';
    else if (counts.get(row.id) > 1) problems[row.key] = 'duplicate';
  }
  return problems;
}

/** Providers models can be imported for: LLM providers whose API type lists models. */
export function getImportableProviders(providers) {
  return (providers || []).filter(p => CUSTOM_PROVIDER_API_TYPES.includes(getProviderApiType(p)));
}

/**
 * The entry for `POST /admin/providers` that a new provider in the dialog
 * becomes. The server encrypts the key.
 */
export function buildNewProviderConfig({ id, name, description, apiType, baseUrl, apiKey }) {
  const provider = {
    id,
    name: name.trim(),
    description: (description || '').trim(),
    category: 'llm',
    apiType,
    enabled: true
  };
  if (baseUrl) provider.baseUrl = baseUrl;
  if (apiKey) provider.apiKey = apiKey;
  return provider;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Build the model config created for one discovered model.
 *
 * Only what the listing actually reported is set: an unknown context window,
 * output cap or tool support is left for the admin to fill in, and iHub's
 * defaults apply until then.
 *
 * @param {Object} entry - One entry of the discovery response's `models`
 * @param {Object} options
 * @param {string} options.id - iHub model id
 * @param {string} options.apiType - API type the endpoint speaks (the model's `provider`)
 * @param {string} options.providerId - Provider entry holding the key
 * @param {string} options.modelsUrl - Listing URL the entry came from (named in the description)
 * @param {boolean} [options.enabled=true]
 * @returns {Object} Model config for `POST /admin/models`
 */
export function buildImportedModelConfig(
  entry,
  { id, apiType, providerId, modelsUrl, enabled = true }
) {
  const host = hostOf(modelsUrl);
  const name = entry.name || entry.id;
  const config = {
    id,
    modelId: entry.id,
    name: { en: name, de: name },
    description: entry.description
      ? { en: entry.description, de: entry.description }
      : { en: `Imported from ${host}.`, de: `Importiert von ${host}.` },
    url: entry.url,
    provider: apiType,
    enabled,
    default: false
  };
  // A built-in provider is named after its API type; linking to it is implied.
  if (providerId && providerId !== apiType) config.providerId = providerId;
  if (entry.contextWindow) config.contextWindow = entry.contextWindow;
  if (entry.maxOutputTokens) config.maxOutputTokens = entry.maxOutputTokens;
  if (entry.supportsVision === true) config.supportsVision = true;
  if (typeof entry.supportsTools === 'boolean') config.supportsTools = entry.supportsTools;
  return config;
}

/** Translation keys for the server's `messageKey` on a failed discovery. */
const DISCOVERY_ERROR_KEYS = {
  invalidUrl: 'admin.models.import.errors.invalidUrl',
  credentialsInUrl: 'admin.models.import.errors.credentialsInUrl',
  unsupportedProvider: 'admin.models.import.errors.unsupportedProvider',
  apiKeyRequired: 'admin.models.import.errors.apiKeyRequired',
  authenticationFailed: 'admin.models.import.errors.authenticationFailed',
  accessDenied: 'admin.models.import.errors.accessDenied',
  notFound: 'admin.models.import.errors.notFound',
  redirected: 'admin.models.import.errors.redirected',
  upstreamError: 'admin.models.import.errors.upstreamError',
  invalidResponse: 'admin.models.import.errors.invalidResponse',
  timeout: 'admin.models.import.errors.timeout',
  connectionRefused: 'admin.models.import.errors.connectionRefused',
  hostNotFound: 'admin.models.import.errors.hostNotFound',
  networkError: 'admin.models.import.errors.networkError'
};

/**
 * Headline for a failed discovery, translated when the server sent a known
 * `messageKey`, else the server's own (English) text.
 */
export function translateDiscoveryError(t, messageKey, fallbackMessage) {
  const key = messageKey ? DISCOVERY_ERROR_KEYS[messageKey] : undefined;
  return key ? t(key, fallbackMessage) : fallbackMessage;
}
