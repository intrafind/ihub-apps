// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getModelProviderId } from '../../../../../shared/llmProviders.js';
import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * The three steps that take a fresh install to a working model, derived from
 * what is configured (nothing is stored): a provider with a key, at least one
 * enabled model, an enabled default model.
 *
 * A keyless endpoint (a local vLLM, LM Studio) does not count as connected by
 * itself: the shipped local provider needs no key and would make a fresh install
 * look half done. It counts once a model is enabled on it.
 *
 * @param {Object} input
 * @param {Object<string, {state: string}>} input.keyStatuses - `GET /admin/providers/_key-status`, by provider id
 * @param {Array<Object>} input.models - Model configs
 * @returns {{ steps: Array<{ id: 'connect'|'enable'|'default', done: boolean, count?: number }>, complete: boolean }}
 */
export function getSetupSteps({ keyStatuses = {}, models = [] }) {
  const enabledCount = models.filter(model => model.enabled).length;
  const steps = [
    {
      id: 'connect',
      done: enabledCount > 0 || Object.values(keyStatuses).some(status => status?.state === 'ok')
    },
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
