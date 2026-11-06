// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
import {
  buildImportedModelConfig,
  isValidId,
  slugify,
  suggestModelId
} from '../../../../../shared/modelImportConfig.js';

// The id rules and the model config an imported model gets live in shared/ so the
// server's gateway sync builds the same ones.
export { buildImportedModelConfig, isValidId, slugify, suggestModelId };

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
export function buildNewProviderConfig({
  id,
  name,
  description,
  apiType,
  baseUrl,
  apiKey,
  gateway
}) {
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
  if (gateway) provider.gateway = gateway;
  return provider;
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
