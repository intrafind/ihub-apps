// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Turning a model a provider lists into an iHub model config, and the id rules
 * that go with it. Shared by the admin "Import from URL" dialog and the server's
 * model gateway sync (`server/services/gatewayDrift.js`), so that a model added by
 * either is configured the same way. Pure: no React, no server imports.
 */

import { BUILT_IN_LLM_PROVIDERS } from './llmProviders.js';
import { TOOL_SUPPORT } from './modelCapabilities.js';

/** Same rule as the `id` field of the model and provider schemas. */
const ID_PATTERN = /^[a-z0-9._-]+$/;

/** Names `isValidId` in server/utils/pathSecurity.js refuses as IDs. */
const DANGEROUS_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Turn free text into an id: lower-case, every run of characters outside
 * `[a-z0-9._-]` collapsed into one hyphen (`Qwen/Qwen3-8B` → `qwen-qwen3-8b`).
 *
 * @param {string} text
 * @returns {string} Empty when nothing usable is left
 */
export function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-');
  // Trim separators with a loop: `/[-._]+$/` backtracks quadratically on
  // input made of many separators.
  let start = 0;
  let end = slug.length;
  while (start < end && '-._'.includes(slug[start])) start++;
  while (end > start && '-._'.includes(slug[end - 1])) end--;
  return slug.slice(start, end);
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

/**
 * Whether the server will accept `id` for a model or provider: the schema's
 * character rule plus the path checks of `isValidId` in
 * server/utils/pathSecurity.js. Checked before anything is created, so an
 * import never creates the provider and then fails on every model.
 */
export function isValidId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 100 &&
    id !== '.' &&
    !id.includes('..') &&
    !DANGEROUS_IDS.has(id) &&
    ID_PATTERN.test(id)
  );
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
 * @param {string} options.apiType - API type the endpoint speaks (the model's `provider`);
 *   a model of a model gateway names its own dialect in `entry.modelProvider`, which wins
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
    provider: entry.modelProvider || apiType,
    enabled,
    default: false
  };
  // A model reaches a built-in provider through its API type; a link to a
  // custom provider is always stored (the server applies the same rule).
  if (providerId && !BUILT_IN_LLM_PROVIDERS.includes(providerId)) {
    config.providerId = providerId;
  }
  // A speech model — Whisper on an OpenAI-compatible endpoint, Gemini or
  // Voxtral transcription and text-to-speech — runs on the speech backend
  // discovery named (`google-live`, `mistral`, …) at the URL it built, and is
  // offered for voice input, transcription or read aloud. Chat settings mean
  // nothing to it.
  if (entry.modelType === 'transcription' || entry.modelType === 'tts') {
    config.provider = entry.backend || entry.modelProvider || apiType;
    config.modelType = entry.modelType;
    return config;
  }
  if (entry.contextWindow) config.contextWindow = entry.contextWindow;
  if (entry.maxOutputTokens) config.maxOutputTokens = entry.maxOutputTokens;
  if (entry.supportsVision === true) config.supportsVision = true;
  // What the provider says about marking this model's output and what the model
  // returns (EU AI Act Art. 50(2)): decided by discovery on the server, copied here.
  if (entry.supportsImageGeneration === true) config.supportsImageGeneration = true;
  if (entry.contentMarking) {
    // A copy per member, so models imported from one listing do not share an object.
    config.contentMarking = Object.fromEntries(
      Object.entries(entry.contentMarking).map(([kind, marking]) => [kind, { ...marking }])
    );
  }
  // Discovery learns whether function calling is offered, not whether the
  // provider accepts a forced call: that is the admin's to raise to `required`.
  if (typeof entry.supportsTools === 'boolean') {
    config.supportsTools = entry.supportsTools ? TOOL_SUPPORT.AUTO : TOOL_SUPPORT.NONE;
  }
  return config;
}
