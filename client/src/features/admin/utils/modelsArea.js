// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { BUILT_IN_LLM_PROVIDERS, getModelProviderId } from '../../../../../shared/llmProviders.js';
import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * Whether a provider entry is an endpoint the admin set up: a custom provider,
 * or a built-in one given a base URL. The shipped entries without a URL are
 * not, though the local one needs no key.
 *
 * @param {Object|undefined} provider
 * @returns {boolean}
 */
function isConfiguredEndpoint(provider) {
  if (!provider) return false;
  return !BUILT_IN_LLM_PROVIDERS.includes(provider.id) || Boolean(provider.baseUrl);
}

/**
 * The three steps that take a fresh install to a working model, derived from
 * what is configured (nothing is stored): a provider with a key (or an endpoint
 * that needs none), at least one enabled model, an enabled default model.
 *
 * A keyless endpoint (a local vLLM, LM Studio: key status `keyless`) counts as
 * connected once the admin set it up, as a custom provider or with a base URL
 * (AI-B21). The shipped local provider is keyless too but points nowhere, so it
 * alone does not make a fresh install look half done. Any provider counts once a
 * model is enabled.
 *
 * @param {Object} input
 * @param {Object<string, {state: string}>} input.keyStatuses - `GET /admin/providers/_key-status`, by provider id
 * @param {Array<Object>} input.models - Model configs
 * @param {Array<Object>} [input.providers] - `GET /admin/providers` entries, to tell a
 *   configured keyless endpoint from the shipped one
 * @returns {{ steps: Array<{ id: 'connect'|'enable'|'default', done: boolean, count?: number }>, complete: boolean }}
 */
export function getSetupSteps({ keyStatuses = {}, models = [], providers = [] }) {
  const enabledCount = models.filter(model => model.enabled).length;
  const connected = Object.entries(keyStatuses).some(
    ([providerId, status]) =>
      status?.state === 'ok' ||
      (status?.state === 'keyless' &&
        isConfiguredEndpoint((providers || []).find(provider => provider.id === providerId)))
  );
  const steps = [
    { id: 'connect', done: enabledCount > 0 || connected },
    { id: 'enable', done: enabledCount > 0, count: enabledCount },
    { id: 'default', done: models.some(model => model.enabled && model.default) }
  ];
  return { steps, complete: steps.every(step => step.done) };
}

/**
 * The provider entry a model takes its key and timeouts from, and a name to show
 * for it. A model that uses no entry (iAssistant, a realtime speech backend)
 * has none: the caller falls back to its API type.
 *
 * @param {Object} model
 * @param {Array<Object>} providers
 * @param {string} [language]
 * @returns {{ id: string|null, entry: Object|undefined, name: string|null }}
 */
export function describeModelProvider(model, providers, language) {
  const id = getModelProviderId(model);
  const entry = id ? (providers || []).find(provider => provider.id === id) : undefined;
  return { id, entry, name: entry ? getLocalizedContent(entry.name, language) || entry.id : null };
}

/** True for a provider entry that holds the endpoint of a model provider. */
export function isLlmProviderEntry(provider) {
  return (provider?.category || 'llm') === 'llm';
}
