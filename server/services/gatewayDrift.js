// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Drift between a provider's model listing and the models imported from it.
 * Used for an iFinder Model Gateway, Google, Anthropic and AWS Bedrock (see `supportsModelSync`).
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
 * A model missing from the listing is reported `removed` only where the listing
 * names every model a config can point at (a gateway, Google). Anthropic names
 * the dated snapshot of a model before the 4.6 generation, while a config often
 * uses the alias (`claude-haiku-4-5`), so there a missing model proves nothing and
 * is left alone.
 *
 * AWS Bedrock lists its models per region and they have no URL (the adapter builds
 * it from the region). Its listing is compared with the linked models of the same
 * region only: a model's own `config.region`, or the listing's region for a model
 * without one. A model added from it stores that region. A model missing from it is
 * left alone too: a config can name an application inference profile or a custom
 * model, which the listing does not show.
 *
 * @module server/services/gatewayDrift
 */

import {
  getLinkedModels,
  getProviderApiType,
  isGatewayProvider
} from '../../shared/llmProviders.js';
import {
  buildImportedModelConfig,
  isValidId,
  suggestModelId
} from '../../shared/modelImportConfig.js';
import { comparableUrl, stripTrailingSlashes } from './ModelEndpointDiscovery.js';
import { providerMarkingFacts } from './provenance/providerMarking.js';

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

/** Whether the model config sets a sampling parameter (see `samplingSchema`). */
function hasSamplingOverride(model) {
  return ['temperature', 'topP', 'topK'].some(key => model.sampling?.[key] !== undefined);
}

/**
 * Whether the listing of this provider names every model a config can point at, so
 * that a configured model missing from it is gone. See the module comment.
 */
function listingNamesEveryModel(provider) {
  return isGatewayProvider(provider) || getProviderApiType(provider) === 'google';
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
  // The provider's mark may not appear under a non-default sampling setting: a model
  // that sets one is not offered a declaration the provider does not stand behind.
  if (entry.markingNeedsDefaultSampling && hasSamplingOverride(model)) return null;
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

/**
 * The kinds (`text`, `image`) of a configured model that its provider declares a mark
 * for and the model does not carry yet: what **Sync models** would offer, worked out
 * from the model alone, without asking the provider. Used by the EU AI Act overview
 * to point an admin at the Sync button of the model. Empty for a provider that
 * declares nothing (Mistral, OpenAI, local), for models that generate nothing to mark
 * and for a model that already has a marking.
 *
 * @param {Object} model - A model config (`provider`, `modelId`, `url`, `contentMarking`, …)
 * @returns {Array<'text'|'image'>}
 */
export function providerMarkingOffer(model) {
  if (!model || modelClass(model) !== 'chat') return [];
  const facts = providerMarkingFacts(
    model.provider,
    { id: model.modelId || model.id, type: 'chat' },
    {
      baseUrl: model.url
    }
  );
  const next = markingToAdopt(model, {
    contentMarking: facts.contentMarking,
    markingNeedsDefaultSampling: facts.markingNeedsDefaultSampling
  });
  if (!next) return [];
  return ['text', 'image'].filter(
    kind => isMarked(next[kind]) && !isMarked(model.contentMarking?.[kind])
  );
}

/** The fields of `model` that differ from what the provider lists for it now. */
function changesOf(model, entry, apiType) {
  const changes = [];
  const push = (field, from, to) => {
    if (from !== to) changes.push({ field, from: from ?? null, to });
  };

  // A Bedrock listing has no URLs: the adapter builds them from the region.
  if (
    typeof entry.url === 'string' &&
    stripTrailingSlashes(model.url || '') !== stripTrailingSlashes(entry.url)
  ) {
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
 * The listed entries by the id a config can name them with. Anthropic lists a model
 * before the 4.6 generation by its dated snapshot (`claude-haiku-4-5-20251001`),
 * which also answers to the dateless alias (`claude-haiku-4-5`) that configs use,
 * so the alias finds the same entry. An id the listing names itself always wins.
 */
function remoteIndex(entries, apiType) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (apiType !== 'anthropic') return byId;
  for (const entry of entries) {
    const alias = /^(.+)-\d{8}$/.exec(entry.id)?.[1];
    if (alias && !byId.has(alias)) byId.set(alias, entry);
  }
  return byId;
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
 * @param {string} [params.region] - AWS Bedrock only: the region the listing was read in.
 *   Only linked models of that region are compared, and an added model stores it.
 * @returns {Array<
 *   { kind: 'added', remoteId: string, name: string, model: Object }
 *   | { kind: 'changed', remoteId: string, modelId: string,
 *       changes: Array<{ field: string, from: unknown, to: unknown }> }
 *   | { kind: 'removed', remoteId: string, modelId: string, reason: 'missing'|'unsupported' }
 * >}
 */
export function computeGatewayDrift({ provider, models, entries, modelsUrl, region }) {
  const apiType = getProviderApiType(provider);
  const scope = listingScope(apiType, region);
  const linked = getLinkedModels(provider.id, models).filter(scope.includes);
  const byRemoteId = remoteIndex(entries, apiType);
  const items = [
    ...linkedDrift({
      linked,
      byRemoteId,
      apiType,
      reportMissing: listingNamesEveryModel(provider)
    }),
    ...addedItems({ provider, models, entries, modelsUrl, linked, byRemoteId, apiType, scope })
  ];
  return items.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.remoteId.localeCompare(b.remoteId) ||
      (a.modelId || '').localeCompare(b.modelId || '')
  );
}

/**
 * Whether a configured model is in an AWS Bedrock listing of `region`: its own
 * `config.region`, or the listing's region when it has none (the adapter then calls
 * it in that region). Also checked again on the stored model before a sync writes it.
 *
 * @param {Object} model - A model config
 * @param {string} region - The region the listing was read in
 * @returns {boolean}
 */
export function inBedrockListingRegion(model, region) {
  return (model?.config?.region || region) === region;
}

/**
 * What a listing covers. Most listings cover every linked model of the provider; an
 * AWS Bedrock listing covers the models of its region only, and they have no URL.
 */
function listingScope(apiType, region) {
  if (apiType !== 'bedrock') {
    return {
      bedrock: false,
      region: undefined,
      includes: () => true,
      // A model configured by hand for the same endpoint counts as imported, as it
      // does for the import dialog's "Already added".
      configuredKey: (modelId, url) => `${modelId}\n${comparableUrl(url)}`,
      configures: () => true
    };
  }
  const includes = model => inBedrockListingRegion(model, region);
  return {
    bedrock: true,
    region,
    includes,
    // No URLs: a Bedrock model of the same region with that id counts as imported.
    configuredKey: modelId => modelId,
    configures: model => model.provider === 'bedrock' && includes(model)
  };
}

/** `changed` and `removed` items of the linked models. */
function linkedDrift({ linked, byRemoteId, apiType, reportMissing }) {
  const items = [];
  for (const model of linked) {
    const entry = byRemoteId.get(model.modelId);
    if (!entry || entryClass(entry) !== modelClass(model)) {
      // A model the admin has switched off is already handled.
      if (model.enabled === false) continue;
      if (!entry && !reportMissing) continue;
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
  return items;
}

/** `added` items: listed models nobody imported or configured by hand. */
function addedItems({ provider, models, entries, modelsUrl, linked, byRemoteId, apiType, scope }) {
  const linkedRemoteIds = new Set(linked.map(model => model.modelId));
  // A model imported under an alias counts as importing the entry the alias resolves to.
  const linkedEntries = new Set(linked.map(model => byRemoteId.get(model.modelId)));
  const configured = new Set(
    models.filter(scope.configures).map(m => scope.configuredKey(m.modelId, m.url))
  );
  const taken = new Set(models.map(model => model.id));
  const items = [];

  for (const entry of entries) {
    if (!entryClass(entry)) continue;
    if (linkedRemoteIds.has(entry.id) || linkedEntries.has(entry)) continue;
    if (configured.has(scope.configuredKey(entry.id, entry.url))) continue;
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
        modelsUrl,
        ...(scope.bedrock && scope.region ? { region: scope.region } : {})
      })
    });
  }
  return items;
}
