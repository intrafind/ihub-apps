// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Step logic of "Connect a model provider" (AdminProviderConnectPage), the
 * guided flow that takes an admin from "where are my models?" to a provider,
 * its linked models, a default model and the groups that may use them.
 *
 * The flow composes endpoints that already exist, in the order the import
 * dialog uses them:
 *   1. `POST /admin/models/_discover` tests the connection (nothing stored)
 *   2. `POST /admin/providers` creates a new provider, or
 *      `PUT /admin/providers/{id}` stores the key on a shipped one
 *   3. `POST /admin/models` once per picked model (linked via `providerId`,
 *      no key of its own; the chosen default carries `default: true`)
 *   4. `PUT /admin/groups/{id}` adds the model ids to the chosen groups, with
 *      `If-Match` from a fresh read of the groups (one re-read and retry on 412)
 *
 * Everything here is free of React so the step rules can be unit tested;
 * the page only renders state and calls {@link runConnectPlan}.
 */

import {
  CUSTOM_PROVIDER_API_TYPES,
  GATEWAY_API_TYPES,
  IFINDER_GATEWAY,
  isCustomLlmProvider,
  isReservedProviderId,
  providerEnvKeyName
} from '../../../../../shared/llmProviders.js';
import { buildImportedModelConfig, isValidId, slugify } from './modelImport';
import { etagOf, isConfigConflict } from '../../../api/adminConfigRevision';
import { DEFAULT_MODEL_TOKEN } from '../../../../../shared/modelPermissions.js';
import {
  DEFAULT_BEDROCK_REGION,
  bedrockEndpointRegion,
  isValidBedrockRegion
} from '../../../../../shared/bedrockRegions.js';

/**
 * Wizard steps in order. Every tile walks all of them; Bedrock lists its
 * models per AWS region instead of per URL (see {@link buildDiscoveryRequest}).
 */
export const CONNECT_STEPS = Object.freeze([
  'vendor',
  'connection',
  'test',
  'models',
  'default',
  'access',
  'done'
]);

/**
 * Kinds of self-hosted server the "self-hosted" tile offers, with the API
 * type iHub talks to each with. vLLM gets its own adapter (`local`); LM
 * Studio and Ollama serve the OpenAI API (docs/local-llm-providers.md).
 */
export const SELF_HOSTED_SERVERS = Object.freeze([
  {
    id: 'vllm',
    name: 'vLLM',
    apiType: 'local',
    urlPlaceholder: 'http://localhost:8000/v1'
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    apiType: 'openai',
    urlPlaceholder: 'http://localhost:1234/v1'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    apiType: 'openai',
    urlPlaceholder: 'http://localhost:11434/v1'
  }
]);

/**
 * Where models can live. Every tile maps onto an adapter the server ships
 * (server/adapters): the OpenAI, Anthropic, Google, Mistral, vLLM and Bedrock
 * adapters, and the iFinder Model Gateway support of the OpenAI/vLLM ones.
 *
 * - `providerId`: a provider entry the platform ships (providers.json); when
 *   it exists the key is stored on it instead of creating a new one.
 * - `apiType`: the API type a new provider declares.
 * - `newProvider`: id and name a new provider gets (editable in step 2).
 * - `shippedOnly`: the flow never creates this provider; the tile is offered
 *   only while the shipped entry exists (Bedrock).
 * - `region`: the endpoint is chosen by AWS region, not by URL (Bedrock).
 *
 * Labels and descriptions are translated in the page by tile id; the English
 * text here is the fallback.
 */
export const CONNECT_TILES = Object.freeze([
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models from api.openai.com.',
    providerId: 'openai',
    apiType: 'openai',
    defaultUrl: 'https://api.openai.com/v1',
    urlFixed: true,
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    description: 'OpenAI models deployed in your Azure resource.',
    apiType: 'openai',
    newProvider: { id: 'azure-openai', name: 'Azure OpenAI' },
    urlPlaceholder: 'https://my-resource.openai.azure.com/openai/v1',
    keyPlaceholder: '',
    keyUrl: 'https://portal.azure.com/'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models from api.anthropic.com.',
    providerId: 'anthropic',
    apiType: 'anthropic',
    defaultUrl: 'https://api.anthropic.com/v1',
    urlFixed: true,
    keyPlaceholder: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Gemini models from the Google AI API.',
    providerId: 'google',
    apiType: 'google',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
    urlFixed: true,
    keyPlaceholder: 'AIzaSy...',
    keyUrl: 'https://aistudio.google.com/app/apikey'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Mistral models from api.mistral.ai.',
    providerId: 'mistral',
    apiType: 'mistral',
    defaultUrl: 'https://api.mistral.ai/v1',
    urlFixed: true,
    keyPlaceholder: '',
    keyUrl: 'https://console.mistral.ai/api-keys/'
  },
  {
    id: 'bedrock',
    name: 'AWS Bedrock',
    description: 'Foundation models through the Bedrock Converse API.',
    providerId: 'bedrock',
    apiType: 'bedrock',
    shippedOnly: true,
    region: true,
    keyPlaceholder: '',
    keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One API for models of many vendors.',
    providerId: 'openrouter',
    apiType: 'openai',
    newProvider: { id: 'openrouter', name: 'OpenRouter' },
    defaultUrl: 'https://openrouter.ai/api/v1',
    urlFixed: true,
    keyPlaceholder: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible gateway',
    description: 'A gateway such as T-Systems LLM Hub or LiteLLM.',
    apiType: 'openai',
    newProvider: { id: '', name: '' },
    urlPlaceholder: 'https://llm-server.llmhub.t-systems.net/v2',
    keyPlaceholder: ''
  },
  {
    id: 'self-hosted',
    name: 'Self-hosted',
    description: 'vLLM, LM Studio or Ollama on your own hardware.',
    apiType: 'local',
    newProvider: { id: 'vllm', name: 'vLLM' },
    selfHosted: true,
    keyPlaceholder: ''
  },
  {
    id: 'ifinder-gateway',
    name: 'iFinder Model Gateway',
    description: 'The model gateway of an iFinder installation.',
    apiType: 'openai',
    gateway: IFINDER_GATEWAY,
    newProvider: { id: 'ifinder-gateway', name: 'iFinder Model Gateway' },
    urlPlaceholder: 'https://gateway.example.com:9614',
    keyPlaceholder: ''
  }
]);

/** API types a tile may use: what the discovery endpoint and the adapters support. */
const SUPPORTED_API_TYPES = new Set([...CUSTOM_PROVIDER_API_TYPES, 'bedrock']);

/**
 * The tiles this platform can serve: an adapter for the API type exists, and
 * a tile bound to a shipped-only provider (Bedrock, which is never created
 * here) is offered only while that provider exists.
 *
 * @param {Array<Object>} providers - `GET /admin/providers` items
 * @returns {Array<Object>} Tiles in display order
 */
export function getAvailableTiles(providers) {
  const ids = new Set((providers || []).map(p => p.id));
  return CONNECT_TILES.filter(tile => {
    if (!SUPPORTED_API_TYPES.has(tile.apiType)) return false;
    if (tile.shippedOnly) return ids.has(tile.providerId);
    return true;
  });
}

/** Find a tile by id; `undefined` for an unknown one (a stale `?vendor=` link). */
export function findTile(tileId) {
  return CONNECT_TILES.find(tile => tile.id === tileId);
}

/**
 * Steps a tile walks through: all of them, for every tile (Bedrock included,
 * whose models are listed per region).
 *
 * @param {Object|undefined} _tile
 * @returns {string[]}
 */
export function stepsForTile(_tile) {
  return [...CONNECT_STEPS];
}

/** The step after `step` for `tile`, or `step` itself at the end. */
export function nextStep(tile, step) {
  const steps = stepsForTile(tile);
  const index = steps.indexOf(step);
  return index >= 0 && index < steps.length - 1 ? steps[index + 1] : step;
}

/** The step before `step` for `tile`, or `step` itself at the start. */
export function previousStep(tile, step) {
  const steps = stepsForTile(tile);
  const index = steps.indexOf(step);
  return index > 0 ? steps[index - 1] : step;
}

/**
 * The connection form a tile starts with.
 *
 * @param {Object} tile
 * @param {Object|undefined} existing - The shipped provider entry the tile targets, if present
 * @returns {Object} Form state for step 2
 */
export function initialConnectionForm(tile, existing) {
  const server = tile.selfHosted ? SELF_HOSTED_SERVERS[0] : null;
  return {
    name: tile.newProvider?.name || (server ? server.name : ''),
    id: tile.newProvider?.id || (server ? server.id : ''),
    idEdited: false,
    url: existing?.baseUrl || tile.defaultUrl || '',
    apiKey: '',
    serverKind: server?.id || '',
    apiType: server?.apiType || tile.apiType,
    gatewayApiType: tile.gateway ? GATEWAY_API_TYPES[0] : undefined,
    // Bedrock: the region stored on the provider, else the adapter's default.
    region: tile.region ? existing?.config?.region || DEFAULT_BEDROCK_REGION : ''
  };
}

/**
 * Why the AWS region of a region tile (Bedrock) cannot be used, if it cannot.
 *
 * @param {Object} tile
 * @param {Object} form
 * @returns {'required'|'invalid'|null}
 */
export function regionProblem(tile, form) {
  if (!tile.region) return null;
  const region = (form.region || '').trim();
  if (!region) return 'required';
  if (!isValidBedrockRegion(region)) return 'invalid';
  return null;
}

/**
 * Apply one field change to the connection form. The id follows the name until
 * the admin edits it; picking a self-hosted server kind changes the API type
 * and, unless edited, the name and id.
 *
 * @param {Object} form
 * @param {string} field
 * @param {string} value
 * @returns {Object} The next form
 */
export function updateConnectionForm(form, field, value) {
  const next = { ...form, [field]: value };
  if (field === 'name' && !form.idEdited) next.id = slugify(value);
  if (field === 'id') next.idEdited = true;
  if (field === 'serverKind') {
    const server = SELF_HOSTED_SERVERS.find(s => s.id === value);
    if (server) {
      next.apiType = server.apiType;
      if (!form.idEdited) {
        next.name = server.name;
        next.id = server.id;
      }
    }
  }
  return next;
}

/**
 * Whether the flow stores the key on an existing provider or creates one.
 * Shipped vendor providers (OpenAI, Anthropic, …, OpenRouter, Bedrock) are
 * reused while they exist; everything else is a new provider.
 *
 * @param {Object} tile
 * @param {Array<Object>} providers - `GET /admin/providers` items
 * @returns {{ mode: 'existing'|'new', provider?: Object }}
 */
export function resolveTarget(tile, providers) {
  const existing = tile.providerId
    ? (providers || []).find(p => p.id === tile.providerId)
    : undefined;
  if (existing) return { mode: 'existing', provider: existing };
  return { mode: 'new' };
}

/**
 * Why the new provider's id cannot be used, if it cannot.
 *
 * @param {string} id
 * @param {Array<Object>} providers
 * @returns {'required'|'invalid'|'reserved'|'exists'|null}
 */
export function newProviderIdProblem(id, providers) {
  if (!id) return 'required';
  if (!isValidId(id)) return 'invalid';
  if (isReservedProviderId(id)) return 'reserved';
  if ((providers || []).some(p => p.id === id)) return 'exists';
  return null;
}

/**
 * The API type the endpoint is called with: the self-hosted server kind's,
 * the gateway dialect, or the tile's.
 */
export function effectiveApiType(tile, form) {
  if (tile.gateway) return form.gatewayApiType || GATEWAY_API_TYPES[0];
  if (tile.selfHosted) return form.apiType;
  return tile.apiType;
}

/**
 * Whether step 2 is complete enough to test the connection.
 *
 * @param {Object} tile
 * @param {Object} form
 * @param {{ mode: string }} target
 * @param {Array<Object>} providers
 * @returns {boolean}
 */
export function canTestConnection(tile, form, target, providers) {
  if (tile.region) {
    // Bedrock: a region instead of a URL. The key may be typed, stored or set
    // as BEDROCK_API_KEY on the server; the test says which is missing.
    return target.mode === 'existing' && regionProblem(tile, form) === null;
  }
  if (!form.url.trim()) return false;
  if (target.mode === 'new') {
    if (!form.name.trim()) return false;
    if (newProviderIdProblem(form.id, providers)) return false;
  }
  return true;
}

/**
 * Body for `POST /admin/models/_discover`. For an existing provider the
 * server uses its stored key (or environment variable) unless a new one was
 * typed; the key typed here is never stored by this call. Bedrock sends the
 * AWS region instead of a URL.
 */
export function buildDiscoveryRequest(tile, form, target) {
  const url = form.url.trim();
  const apiKey = form.apiKey.trim();
  if (tile.region && target.mode === 'existing') {
    return {
      providerId: target.provider.id,
      region: form.region.trim(),
      ...(apiKey ? { apiKey } : {})
    };
  }
  if (target.mode === 'existing') {
    return { url, providerId: target.provider.id, ...(apiKey ? { apiKey } : {}) };
  }
  return {
    url,
    apiType: effectiveApiType(tile, form),
    ...(apiKey ? { apiKey } : {}),
    ...(tile.gateway ? { gateway: tile.gateway } : {})
  };
}

/**
 * The URL the connection test calls, for display while it runs: the URL
 * typed, or for Bedrock the control plane of the region chosen.
 *
 * @param {Object} tile
 * @param {Object} form
 * @returns {string}
 */
export function connectionUrl(tile, form) {
  if (tile.region) {
    const region = (form.region || '').trim();
    return isValidBedrockRegion(region)
      ? `https://bedrock.${bedrockEndpointRegion(region)}.amazonaws.com`
      : '';
  }
  return form.url || '';
}

/** Host of a URL for display (`api.openai.com`), or the input when it is not one. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

/** Network-level failures: the server could not reach the endpoint at all. */
const UNREACHABLE_KEYS = new Set(['hostNotFound', 'connectionRefused', 'networkError', 'timeout']);
/** The endpoint answered, but refused the credentials. */
const AUTH_KEYS = new Set(['apiKeyRequired', 'authenticationFailed', 'accessDenied']);
/** The endpoint answered, but not with a model list at this path. */
const PATH_KEYS = new Set(['notFound', 'invalidResponse', 'redirected']);
/** Certificate problems, by key or by the text Node reports for them. */
const TLS_PATTERN =
  /cert|tls|ssl|self[- ]signed|unable to verify|UNABLE_TO_VERIFY|DEPTH_ZERO|UNABLE_TO_GET_ISSUER/i;

/**
 * Sort a failed test into the cause the wizard explains, from the
 * `details.messageKey` the shared discovery error mapping sends
 * (server/services/ModelEndpointDiscovery.js; translated by
 * `translateDiscoveryError`). TLS is recognised by key or by the certificate
 * error text in the remediation, so a private CA points at the SSL whitelist
 * whichever key the mapping chooses for it.
 *
 * @param {string|undefined} messageKey
 * @param {string|undefined} remediation - `details.remediation` / detail text
 * @param {number|undefined} upstreamStatus
 * @returns {'tls'|'unreachable'|'auth'|'path'|'other'}
 */
export function classifyConnectionError(messageKey, remediation, upstreamStatus) {
  if (
    (messageKey && TLS_PATTERN.test(messageKey)) ||
    (remediation && TLS_PATTERN.test(remediation))
  ) {
    return 'tls';
  }
  if (messageKey && UNREACHABLE_KEYS.has(messageKey)) return 'unreachable';
  if (messageKey && AUTH_KEYS.has(messageKey)) return 'auth';
  if (messageKey && PATH_KEYS.has(messageKey)) return 'path';
  if (upstreamStatus === 401 || upstreamStatus === 403) return 'auth';
  if (upstreamStatus === 404) return 'path';
  return 'other';
}

/**
 * The environment variable that can hold the key instead of the form.
 * For a new provider it follows the id being typed.
 */
export function envVarFor(form, target) {
  const id = target.mode === 'existing' ? target.provider.id : form.id;
  return id ? providerEnvKeyName(id) : null;
}

/**
 * Prefix suggested for model ids: none for a shipped vendor provider (its
 * model ids are the vendor's own), the provider id for a new or custom one.
 */
export function suggestedIdPrefix(target, form) {
  if (target.mode === 'existing' && !isCustomLlmProvider(target.provider)) return '';
  const id = target.mode === 'existing' ? target.provider.id : form.id;
  return id ? `${id}-` : '';
}

/**
 * Chat models among the picks: only those can be the default model.
 *
 * @param {Array<{ model: Object, id: string }>} picks
 * @returns {Array<{ model: Object, id: string }>}
 */
export function defaultCandidates(picks) {
  return picks.filter(pick => (pick.model.type || 'chat') === 'chat');
}

/** Value of the "keep the current default" choice in step 5. */
export const KEEP_DEFAULT = '__keep__';

/**
 * Whether step 5 has an explicit answer: one of the picked chat models, or
 * "keep the current default" when one exists. A fresh install with no default
 * must choose one, unless nothing picked can be one (then there is nothing to choose).
 *
 * @param {string|null} choice
 * @param {Array<{ id: string }>} candidates
 * @param {Object|null} currentDefault - The model that is default today, if any
 * @returns {boolean}
 */
export function isDefaultChoiceValid(choice, candidates, currentDefault) {
  if (candidates.length === 0) return true;
  if (choice === KEEP_DEFAULT) return Boolean(currentDefault);
  return candidates.some(c => c.id === choice);
}

/** The enabled model flagged `default` today, if any. */
export function findCurrentDefault(models) {
  return (models || []).find(m => m.default === true && m.enabled !== false) || null;
}

/**
 * Groups that see every model already (`models: ["*"]`): adding ids to them
 * changes nothing, and they keep seeing the new models whatever is chosen.
 *
 * @param {Object} groupsFile - `GET /admin/groups` body (`{ groups: { id: group } }`)
 * @returns {string[]} Group ids
 */
export function wildcardModelGroups(groupsFile) {
  return Object.entries(groupsFile?.groups || {})
    .filter(([, group]) => (group?.permissions?.models || []).includes('*'))
    .map(([id]) => id);
}

/**
 * Groups that grant "the default model" (`@default`) without granting every
 * model: whichever model is made the default, they can use it, and so can
 * every group that inherits from them (on a new installation `anonymous`, which
 * every signed-in user inherits).
 *
 * @param {Object} groupsFile - `GET /admin/groups` body (`{ groups: { id: group } }`)
 * @returns {string[]} Group ids
 */
export function defaultTokenModelGroups(groupsFile) {
  return Object.entries(groupsFile?.groups || {})
    .filter(([, group]) => {
      const models = group?.permissions?.models || [];
      return models.includes(DEFAULT_MODEL_TOKEN) && !models.includes('*');
    })
    .map(([id]) => id);
}

/** Group that "everyone who signs in" maps to (the base of the group hierarchy). */
export const EVERYONE_GROUP = 'authenticated';

/**
 * `PUT /admin/groups/{id}` bodies that grant the new models. `everyone` grants
 * them to the `authenticated` group, which every signed-in user is in and
 * every other group inherits from; `groups` grants them to the picked groups.
 * A group that already has `*` or the ids is left alone.
 *
 * @param {Object} groupsFile - `GET /admin/groups` body
 * @param {{ mode: 'everyone'|'groups', groupIds?: string[] }} access
 * @param {string[]} modelIds
 * @returns {Array<{ groupId: string, models: string[] }>}
 */
export function planGroupUpdates(groupsFile, access, modelIds) {
  const groups = groupsFile?.groups || {};
  const targets = access.mode === 'everyone' ? [EVERYONE_GROUP] : access.groupIds || [];
  const updates = [];
  for (const groupId of targets) {
    const group = groups[groupId];
    if (!group) continue;
    const current = group.permissions?.models || [];
    if (current.includes('*')) continue;
    const missing = modelIds.filter(id => !current.includes(id));
    if (missing.length === 0) continue;
    updates.push({ groupId, models: [...current, ...missing] });
  }
  return updates;
}

/**
 * The provider write step 2's answers need, or `null` when nothing changes
 * (an existing provider that already holds a key and is enabled).
 *
 * New provider: `POST /admin/providers` with the endpoint the test resolved
 * (`discovery.baseUrl`), the key (the server encrypts it) and, for a
 * self-hosted server without key, `requiresApiKey: false` so its models
 * count as keyless. Existing provider: `PUT` of the entry as listed, plus the
 * new key and `enabled: true`. For Bedrock the region the models were listed
 * in is stored too (`config.region`): the imported models carry inference
 * profile ids of that region's geography and are called there.
 *
 * @param {Object} tile
 * @param {Object} form
 * @param {{ mode: string, provider?: Object }} target
 * @param {Object|null} discovery - `_discover` response
 * @returns {{ method: 'POST'|'PUT', path: string, body: Object }|null}
 */
export function buildProviderWrite(tile, form, target, discovery) {
  const apiKey = form.apiKey.trim();
  if (target.mode === 'existing') {
    const { apiKeySet: _set, apiKeyMasked: _masked, ...entry } = target.provider;
    const region = tile.region ? discovery?.region || form.region.trim() : '';
    const regionChanged = Boolean(region) && entry.config?.region !== region;
    if (!apiKey && entry.enabled !== false && !regionChanged) return null;
    const body = { ...entry, enabled: true };
    if (regionChanged) body.config = { ...entry.config, region };
    // The server keeps the stored key for the masked placeholder.
    body.apiKey = apiKey || (target.provider.apiKeySet ? '••••••••' : undefined);
    if (body.apiKey === undefined) delete body.apiKey;
    return {
      method: 'PUT',
      path: `/admin/providers/${encodeURIComponent(entry.id)}`,
      body
    };
  }
  const body = {
    id: form.id,
    name: form.name.trim(),
    description: '',
    category: 'llm',
    apiType: effectiveApiType(tile, form),
    enabled: true
  };
  const baseUrl = discovery?.baseUrl || form.url.trim();
  if (baseUrl) body.baseUrl = baseUrl;
  if (apiKey) body.apiKey = apiKey;
  if (tile.gateway) body.gateway = tile.gateway;
  // No key, yet the connection test passed (or a self-hosted server, which
  // usually runs without one): the endpoint is open, so the provider is keyless.
  // Without the flag its models would fail with a missing-key error.
  if (!apiKey && (tile.selfHosted || discovery)) body.requiresApiKey = false;
  return { method: 'POST', path: '/admin/providers', body };
}

/**
 * Model configs for `POST /admin/models`, one per pick. Each is linked to the
 * provider (`providerId` for a custom one, the API type for a shipped one) and
 * carries no key: it uses the provider's (AI-PM6). Its inference URL is built
 * from the endpoint the provider holds. The chosen default carries
 * `default: true`; the server clears the flag on every other model.
 *
 * @param {Object} params
 * @param {Object} params.discovery - `_discover` response
 * @param {Array<{ model: Object, id: string, deployment?: string }>} params.picks
 * @param {string} params.providerId - Provider the models are linked to
 * @param {string|null} params.defaultId - iHub id of the new default, or null/KEEP_DEFAULT
 * @returns {Object[]}
 */
export function buildModelConfigs({ discovery, picks, providerId, defaultId }) {
  return picks.map(pick => {
    const remote = discovery.azure
      ? { ...pick.model, id: pick.deployment || pick.model.id }
      : pick.model;
    const config = buildImportedModelConfig(remote, {
      id: pick.id,
      apiType: discovery.apiType,
      providerId,
      modelsUrl: discovery.modelsUrl,
      enabled: true
    });
    if (pick.id === defaultId) config.default = true;
    return config;
  });
}

/**
 * Run the plan: provider, models, groups. Stops before the models when the
 * provider cannot be written (models without their provider would have no
 * key); a model or group that fails is reported and the rest go on, as in the
 * import dialog. Every piece is a valid configuration on its own, so a partial
 * outcome can be finished from the provider and model pages.
 *
 * Group writes replace a group's model list, so they are guarded: each
 * `PUT /admin/groups/{id}` sends the `ETag` of the groups read it was planned
 * from (and then of the previous group write) as `If-Match`. When another admin
 * saved the groups in between, the server answers 412; the groups are then read
 * and planned again, and the write is retried once from that fresh read.
 *
 * @param {Object} params
 * @param {(path: string, options?: Object) => Promise<Object>} params.api - `makeAdminApiCall`
 * @param {(err: unknown) => string} params.errorMessage - `getAdminApiErrorMessage`
 * @param {{ method: string, path: string, body: Object }|null} params.providerWrite
 * @param {Object[]} params.modelConfigs
 * @param {Array<{ groupId: string, models: string[] }>} params.groupUpdates - The plan made
 *   from the groups as the flow loaded them
 * @param {(createdIds: string[]) => Promise<{ updates: Array<{ groupId: string, models: string[] }>, revision: string|null }>} [params.replanGroups]
 *   Reads the groups again and plans the group writes from them as they are now, right before
 *   writing them, so an edit another admin made to those groups while the flow was open is kept.
 *   `revision` is the `ETag` of that read. When it fails, the plan from `groupUpdates` is used,
 *   without `If-Match`.
 * @returns {Promise<{ providerError: string|null, models: Array<{ id: string, ok: boolean, error?: string }>, groups: Array<{ groupId: string, ok: boolean, error?: string }> }>}
 */
export async function runConnectPlan({
  api,
  errorMessage,
  providerWrite,
  modelConfigs,
  groupUpdates,
  replanGroups
}) {
  const outcome = { providerError: null, models: [], groups: [] };
  if (providerWrite) {
    try {
      await api(providerWrite.path, { method: providerWrite.method, body: providerWrite.body });
    } catch (err) {
      outcome.providerError = errorMessage(err);
      return outcome;
    }
  }
  for (const config of modelConfigs) {
    try {
      await api('/admin/models', { method: 'POST', body: config });
      outcome.models.push({ id: config.id, ok: true });
    } catch (err) {
      outcome.models.push({ id: config.id, ok: false, error: errorMessage(err) });
    }
  }
  const created = new Set(outcome.models.filter(m => m.ok).map(m => m.id));
  let queue = groupUpdates;
  let revision = null;
  if (replanGroups && groupUpdates.length > 0) {
    try {
      ({ updates: queue, revision } = await replanGroups([...created]));
    } catch {
      queue = groupUpdates;
      revision = null;
    }
  }

  // Grant only what exists: a model that failed to be created is not listed.
  const grantable = update =>
    update.models.filter(id => created.has(id) || !modelConfigs.some(c => c.id === id));
  const writeGroup = async update => {
    const response = await api(`/admin/groups/${encodeURIComponent(update.groupId)}`, {
      method: 'PUT',
      ...(revision ? { headers: { 'If-Match': revision } } : {}),
      body: { permissions: { models: grantable(update) } }
    });
    // The next group write builds on the file as this one left it.
    revision = etagOf(response);
  };

  queue = [...queue];
  while (queue.length > 0) {
    const update = queue.shift();
    try {
      await writeGroup(update);
      outcome.groups.push({ groupId: update.groupId, ok: true });
    } catch (err) {
      if (!replanGroups || !isConfigConflict(err)) {
        outcome.groups.push({ groupId: update.groupId, ok: false, error: errorMessage(err) });
        continue;
      }
      // Someone saved the groups since they were read: read them again, plan this group and
      // the ones still to write from that read, and retry this one once.
      try {
        const fresh = await replanGroups([...created]);
        revision = fresh.revision;
        const pending = new Set([update.groupId, ...queue.map(u => u.groupId)]);
        const replanned = fresh.updates.filter(u => pending.has(u.groupId));
        const retry = replanned.find(u => u.groupId === update.groupId);
        queue = replanned.filter(u => u.groupId !== update.groupId);
        // Nothing left to grant: the group got the models (or `*`) meanwhile.
        if (retry) await writeGroup(retry);
        outcome.groups.push({ groupId: update.groupId, ok: true });
      } catch (retryErr) {
        outcome.groups.push({ groupId: update.groupId, ok: false, error: errorMessage(retryErr) });
      }
    }
  }
  return outcome;
}
