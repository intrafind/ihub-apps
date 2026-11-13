// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Drift between a provider's model listing and the models imported from it.
 * Used for an iFinder Model Gateway and for Google (see `supportsModelSync`).
 *
 * A provider's models come and go: deployments are registered and removed, their
 * context window or vision support is corrected, a model is moved to another
 * dialect, Google retires a Gemini version. The models imported earlier do not
 * follow by themselves. This compares what the provider lists now (the
 * normalized entries of `discoverModels`) with the models linked to its provider
 * entry and reports, per model, what an admin could do about it. Nothing is
 * changed here: the admin picks, and `gatewaySyncApply.js` applies the pick on
 * the server.
 *
 * Three kinds of item:
 *   - `added`:   the provider lists a model nobody imported. Carries the model
 *                config the import dialog would build, as a preview: applying
 *                builds it again from a fresh listing.
 *   - `changed`: an imported model differs from what the provider reports now
 *                (URL, adapter, context window, vision, EU AI Act marking).
 *                Carries the fields as `{ field, from, to }`.
 *   - `removed`: an enabled imported model the provider no longer lists, or lists
 *                as something iHub cannot run as that model. Disabling it is
 *                offered, deleting is not: apps may still point at it.
 *
 * Models of the provider that iHub cannot run (embedding, NER, Azure realtime)
 * are never `added`. A model the admin disabled is not reported as `removed`.
 *
 * Only what a listing reports is compared. A gateway reports image input per
 * chat model, Google does not (`supportsVision` is then null and left alone).
 *
 * @module server/services/gatewayDrift
 */

import { getLinkedModels, getProviderApiType } from '../../shared/llmProviders.js';
import {
  buildImportedModelConfig,
  isValidId,
  suggestModelId
} from '../../shared/modelImportConfig.js';
import { comparableUrl, stripTrailingSlashes } from './ModelEndpointDiscovery.js';

/** Order the items are reported in. */
const KIND_ORDER = { changed: 0, added: 1, removed: 2 };

/** What a configured model does: chat, `transcription` or `tts`. */
function modelClass(model) {
  if (model.modelType === 'transcription') return 'transcription';
  if (model.modelType === 'tts') return 'tts';
  return 'chat';
}

/** What a listed model can be imported as, or null when iHub cannot run it. */
function entryClass(entry) {
  if (entry.unsupported) return null;
  if (entry.modelType === 'transcription' || entry.modelType === 'tts') return entry.modelType;
  return entry.type === 'chat' ? 'chat' : null;
}

/**
 * The adapter (model `provider`) a listed model is called with: the speech
 * backend, the dialect a gateway named, or else the API type of the provider.
 */
function expectedAdapter(entry, apiType) {
  return entry.backend || entry.modelProvider || apiType;
}

/**
 * Whether the adapter of a configured model is one the listed model can be
 * called with. A gateway's OpenAI-dialect models run on `openai` or `local`
 * (the vLLM adapter), an admin's choice per model that is not drift; the
 * other dialects and the speech backends allow nothing else.
 */
function adapterMatches(configured, expected) {
  if (expected === 'openai' || expected === 'local') {
    return configured === 'openai' || configured === 'local';
  }
  return configured === expected;
}

/** A `contentMarking` member that says something: absent and `by: "none"` both mean unset. */
function isMarked(marking) {
  return Boolean(marking) && marking.by !== 'none';
}

/**
 * The `contentMarking` the model would have after taking over what the provider
 * declares for it (EU AI Act Art. 50(2)), or null when there is nothing to add.
 *
 * Only members the model does not declare yet are filled in: a marking an admin
 * entered stays. An unset member is absent or `by: "none"`, the value migration
 * V243 gave every chat model, so "Not marked" an admin chose on purpose looks the
 * same and is offered again. An image marking is offered only to a model that
 * generates images.
 */
function markingToAdopt(model, entry) {
  const declared = entry.contentMarking;
  if (!declared) return null;
  const current = model.contentMarking || {};
  const next = { ...current };
  let adopted = false;
  for (const kind of ['text', 'image']) {
    if (!isMarked(declared[kind]) || isMarked(current[kind])) continue;
    if (kind === 'image' && model.supportsImageGeneration !== true) continue;
    next[kind] = { ...declared[kind] };
    adopted = true;
  }
  return adopted ? next : null;
}

/** The fields of `model` that differ from what the provider lists for it now. */
function changesOf(model, entry, apiType) {
  const changes = [];
  const push = (field, from, to) => {
    if (from !== to) changes.push({ field, from: from ?? null, to });
  };

  if (stripTrailingSlashes(model.url || '') !== stripTrailingSlashes(entry.url)) {
    push('url', model.url, entry.url);
  }
  const adapter = expectedAdapter(entry, apiType);
  if (!adapterMatches(model.provider, adapter)) {
    push('provider', model.provider, adapter);
  }
  if (modelClass(model) === 'chat') {
    // An unreported window is left as the admin set it.
    if (Number.isInteger(entry.contextWindow)) {
      push('contextWindow', model.contextWindow, entry.contextWindow);
    }
    // Likewise image input: a listing that does not report it says nothing about it.
    if (typeof entry.supportsVision === 'boolean') {
      push('supportsVision', model.supportsVision === true, entry.supportsVision);
    }
    const marking = markingToAdopt(model, entry);
    if (marking) push('contentMarking', model.contentMarking, marking);
  }
  return changes;
}

/**
 * An iHub model id for a listed model that no other model has: the provider's
 * id and the remote id, with a number added when the id is taken. Null when no
 * valid id can be made from the remote id.
 */
function freeModelId(providerId, remoteId, taken) {
  const base = suggestModelId(remoteId, `${providerId}-`);
  if (!base) return null;
  let candidate = base;
  for (let n = 2; taken.has(candidate) || !isValidId(candidate); n++) {
    if (n > 100) return null;
    candidate = `${base}-${n}`;
    if (candidate.length > 100) return null;
  }
  return candidate;
}

/**
 * Compare the provider's listing with the models imported from it.
 *
 * @param {Object} params
 * @param {Object} params.provider - The provider entry (a model gateway, or Google)
 * @param {Object[]} params.models - Every configured model
 * @param {Object[]} params.entries - What the provider lists, normalized and with their URLs
 *   (the `models` of `discoverModels`)
 * @param {string} params.modelsUrl - The listing URL (named in the description of an added model)
 * @returns {Array<
 *   { kind: 'added', remoteId: string, name: string, model: Object }
 *   | { kind: 'changed', remoteId: string, modelId: string,
 *       changes: Array<{ field: string, from: unknown, to: unknown }> }
 *   | { kind: 'removed', remoteId: string, modelId: string, reason: 'missing'|'unsupported' }
 * >}
 */
export function computeGatewayDrift({ provider, models, entries, modelsUrl }) {
  const apiType = getProviderApiType(provider);
  const linked = getLinkedModels(provider.id, models);
  const byRemoteId = new Map(entries.map(entry => [entry.id, entry]));
  const items = [];

  for (const model of linked) {
    const entry = byRemoteId.get(model.modelId);
    if (!entry || entryClass(entry) !== modelClass(model)) {
      // A model the admin has switched off is already handled.
      if (model.enabled === false) continue;
      items.push({
        kind: 'removed',
        remoteId: model.modelId,
        modelId: model.id,
        reason: entry ? 'unsupported' : 'missing'
      });
      continue;
    }
    const changes = changesOf(model, entry, apiType);
    if (changes.length > 0) {
      items.push({ kind: 'changed', remoteId: entry.id, modelId: model.id, changes });
    }
  }

  const linkedRemoteIds = new Set(linked.map(model => model.modelId));
  // A model configured by hand for the same endpoint counts as imported, as it
  // does for the import dialog's "Already added".
  const configured = new Set(models.map(m => `${m.modelId}\n${comparableUrl(m.url)}`));
  const taken = new Set(models.map(model => model.id));

  for (const entry of entries) {
    if (!entryClass(entry)) continue;
    if (linkedRemoteIds.has(entry.id)) continue;
    if (configured.has(`${entry.id}\n${comparableUrl(entry.url)}`)) continue;
    const id = freeModelId(provider.id, entry.id, taken);
    if (!id) continue;
    taken.add(id);
    items.push({
      kind: 'added',
      remoteId: entry.id,
      name: entry.name || entry.id,
      model: buildImportedModelConfig(entry, {
        id,
        apiType,
        providerId: provider.id,
        modelsUrl
      })
    });
  }

  return items.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.remoteId.localeCompare(b.remoteId) ||
      (a.modelId || '').localeCompare(b.modelId || '')
  );
}
