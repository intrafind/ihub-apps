// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { responseEtag } from '../../utils/etag.js';
import { assertValidId, isValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import { getProviderConfigSchema } from '../../adapters/index.js';
import { getProxyConfig, redactUrlSecrets } from '../../utils/httpConfig.js';
import config from '../../config.js';
import logger from '../../utils/logger.js';
import {
  BUILT_IN_LLM_PROVIDERS,
  CUSTOM_PROVIDER_API_TYPES,
  GATEWAY_API_TYPES,
  GATEWAY_KINDS,
  getLinkedModels,
  getProviderApiType,
  inspectProviderApiKey,
  isCustomLlmProvider,
  isGatewayProvider,
  isReservedProviderId,
  linkedModelProvider,
  LLM_TIMEOUT_KEYS,
  LLM_TIMEOUT_MAX_MS,
  resolveProviderApiKey
} from '../../services/llmProviders.js';
import {
  discoverModels,
  MAX_MODELS,
  ModelDiscoveryError,
  stripTrailingSlashes
} from '../../services/ModelEndpointDiscovery.js';
import { computeGatewayDrift } from '../../services/gatewayDrift.js';
import { applyGatewayDrift } from '../../services/gatewaySyncApply.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import { sendCreated, segment } from '../../utils/created.js';

/** The provider configuration, as a path relative to `contents/`. */
const PROVIDERS_FILE = 'config/providers.json';

/** Categories a provider can be created in. */
const PROVIDER_CATEGORIES = ['llm', 'custom'];

/**
 * Validate the transport ceilings of an LLM provider entry, in place: each is a
 * whole number of milliseconds from 0 (no ceiling) to 5 minutes. An empty value
 * removes the key, so the provider inherits the installation's.
 *
 * @param {Object} provider - Provider entry from the request body
 * @returns {string|null} Error message, or null when the ceilings are valid
 */
function normalizeProviderTimeouts(provider) {
  for (const key of LLM_TIMEOUT_KEYS) {
    const value = provider[key];
    if (value === undefined || value === null || value === '') {
      delete provider[key];
    } else if (!Number.isInteger(value) || value < 0 || value > LLM_TIMEOUT_MAX_MS) {
      return `${key} must be a whole number of milliseconds between 0 and ${LLM_TIMEOUT_MAX_MS}`;
    }
  }
  return null;
}

/**
 * Validate and tidy the editable fields of a provider entry, in place.
 *
 * `name` and `description` are plain strings (V141 converted the per-language
 * objects). A custom LLM provider needs the `apiType` its endpoint speaks and
 * may carry a `baseUrl` used to list its models; a built-in LLM provider's API
 * type is its id, so an `apiType` on it is dropped. Other categories have
 * neither field. A custom LLM provider may name the `gateway` it points at
 * (an iFinder Model Gateway), which fixes the API types it can have. An LLM
 * provider may also set `connectTimeoutMs` / `streamIdleTimeoutMs`, the
 * transport ceilings its models inherit (see normalizeProviderTimeouts).
 *
 * @param {Object} provider - Provider entry from the request body
 * @returns {string|null} Error message, or null when the entry is valid
 */
function normalizeProviderFields(provider) {
  if (typeof provider.name !== 'string' || !provider.name.trim()) {
    return 'Provider name is required and must be text';
  }
  provider.name = provider.name.trim();
  if (provider.description === undefined || provider.description === null) {
    provider.description = '';
  }
  if (typeof provider.description !== 'string') {
    return 'Provider description must be text';
  }
  provider.description = provider.description.trim();

  // Entries without a category are the original built-in LLM providers.
  if ((provider.category || 'llm') !== 'llm') {
    delete provider.apiType;
    delete provider.baseUrl;
    delete provider.gateway;
    for (const key of LLM_TIMEOUT_KEYS) delete provider[key];
    return null;
  }

  const timeoutError = normalizeProviderTimeouts(provider);
  if (timeoutError) return timeoutError;

  if (BUILT_IN_LLM_PROVIDERS.includes(provider.id)) {
    delete provider.apiType;
    delete provider.gateway;
  } else if (!CUSTOM_PROVIDER_API_TYPES.includes(provider.apiType)) {
    return `API type must be one of: ${CUSTOM_PROVIDER_API_TYPES.join(', ')}`;
  } else if (
    provider.gateway === undefined ||
    provider.gateway === null ||
    provider.gateway === ''
  ) {
    delete provider.gateway;
  } else if (!GATEWAY_KINDS.includes(provider.gateway)) {
    return `Gateway must be one of: ${GATEWAY_KINDS.join(', ')}`;
  } else if (!GATEWAY_API_TYPES.includes(provider.apiType)) {
    return `A model gateway provider must use the API type ${GATEWAY_API_TYPES.join(' or ')}`;
  }

  if (provider.baseUrl === undefined || provider.baseUrl === null || provider.baseUrl === '') {
    delete provider.baseUrl;
  } else if (
    typeof provider.baseUrl !== 'string' ||
    !/^https?:\/\/[^\s]+$/i.test(provider.baseUrl.trim())
  ) {
    return 'Base URL must be an http:// or https:// URL';
  } else {
    provider.baseUrl = stripTrailingSlashes(provider.baseUrl.trim());
  }
  return null;
}

/**
 * Point every model linked to a custom LLM provider at the provider's API
 * type, so changing it on the provider changes it for all of its models. A
 * Google transcription model keeps its speech backend (linkedModelProvider).
 * A gateway provider is left alone: its models speak different dialects (a
 * Mistral model next to an OpenAI one), each imported with its own adapter.
 *
 * @param {Object} provider - The saved provider entry
 * @returns {Promise<string[]>} Ids of the models rewritten
 */
async function syncLinkedModelsApiType(provider) {
  if (!isCustomLlmProvider(provider) || isGatewayProvider(provider)) return [];
  const apiType = getProviderApiType(provider);
  const { data: models = [] } = configCache.getModels(true);
  const updated = [];
  for (const model of getLinkedModels(provider.id, models)) {
    const next = linkedModelProvider(apiType, model);
    if (model.provider === next) continue;
    const modelPath = await configStore.resolveIdToPath('models', model.id);
    if (!modelPath) continue;
    // Only the provider field, on the stored model: the cached copy can lag
    // behind an edit made to the model meanwhile.
    await configStore.updateJson(modelPath, stored =>
      stored ? { ...stored, provider: next } : undefined
    );
    updated.push(model.id);
  }
  if (updated.length > 0) {
    await configCache.refreshModelsCache();
  }
  return updated;
}

/** Characters kept per echoed field, so one test cannot return a huge payload. */
const SAMPLE_FIELD_LENGTH = 300;

/**
 * The outbound-path facts that decide whether a bot-protection block is
 * explainable — which egress the request takes, and against which endpoint.
 * Proxy URLs are redacted: they routinely embed credentials.
 * @param {string} providerId
 * @returns {{proxy: string|null, proxyEnabled: boolean, endpoint: string|null}}
 */
function describeOutboundPath(providerId) {
  let proxy = null;
  let proxyEnabled = false;
  try {
    const proxyConfig = getProxyConfig();
    proxyEnabled = Boolean(proxyConfig?.enabled && (proxyConfig.https || proxyConfig.http));
    proxy = proxyEnabled ? redactUrlSecrets(proxyConfig.https || proxyConfig.http) : null;
  } catch {
    // A proxy config that cannot be read is not worth failing the test over.
  }

  const endpoints = {
    brave: config.BRAVE_SEARCH_ENDPOINT || 'https://api.search.brave.com/res/v1/web/search',
    qwant: config.QWANT_SEARCH_ENDPOINT || 'https://api.qwant.com/v3/search/',
    staan: config.STAAN_SEARCH_ENDPOINT || 'https://api.staan.ai/v2/search/web'
  };

  return { proxy, proxyEnabled, endpoint: endpoints[providerId] || null };
}

/**
 * Ask a model gateway provider's gateway what it lists now and compare that with the models
 * imported from it. Shared by the drift report and by the sync that applies it, so both see
 * the same thing and fail the same way.
 *
 * @param {string} providerId
 * @returns {Promise<{ provider: Object, modelsUrl: string, items: Array<Object> }>}
 * @throws {ServiceError} `BAD_REQUEST` for an unusable id, a provider that is no gateway or has no
 *   base URL, `NOT_FOUND` for an unknown provider, `UPSTREAM_ERROR` when the gateway cannot be asked
 */
async function loadGatewayDrift(providerId) {
  if (!isValidId(providerId)) throw new ServiceError('BAD_REQUEST', 'Invalid provider ID');

  const { data: providers = [] } = configCache.getProviders(true);
  const provider = providers.find(p => p.id === providerId);
  if (!provider) throw new ServiceError('NOT_FOUND', `Provider ${providerId} not found`);
  if (!isGatewayProvider(provider)) {
    throw new ServiceError('BAD_REQUEST', `Provider ${providerId} is not a model gateway`, {
      details: { providerId }
    });
  }
  if (!provider.baseUrl) {
    throw new ServiceError('BAD_REQUEST', `Provider ${providerId} has no base URL`, {
      details: { providerId }
    });
  }

  let listing;
  try {
    listing = await discoverModels({
      url: provider.baseUrl,
      provider: getProviderApiType(provider),
      apiKey: resolveProviderApiKey(provider) || '',
      gateway: provider.gateway
    });
  } catch (error) {
    if (!(error instanceof ModelDiscoveryError)) throw error;
    // A URL the admin has to fix is theirs (400); anything else is the gateway's.
    throw new ServiceError(error.status === 400 ? 'BAD_REQUEST' : 'UPSTREAM_ERROR', error.message, {
      status: error.status,
      details: {
        reason: error.messageKey,
        upstreamStatus: error.upstreamStatus,
        hint: error.details
      }
    });
  }

  const { data: models = [] } = configCache.getModels(true);
  return {
    provider,
    modelsUrl: listing.modelsUrl,
    items: computeGatewayDrift({
      provider,
      models,
      entries: listing.models,
      modelsUrl: listing.modelsUrl
    })
  };
}

/** Models are stored one file each; sync reads and writes those files, not the config cache. */
const modelStore = {
  read: async id => configStore.readJson(await configStore.resolveIdToPath('models', id)),
  write: async (id, model) =>
    configStore.writeJson(await configStore.resolveIdToPath('models', id), model)
};

/** The provider list in a stored body: `{ providers }`, or a bare array from an older file. */
function storedProviderList(stored) {
  if (Array.isArray(stored)) return stored;
  return Array.isArray(stored?.providers) ? stored.providers : [];
}

/**
 * Change providers.json as one locked read-change-write step, on the stored
 * body — never on the config cache, which can lag behind another writer and
 * would write that writer's change away. `mutate` gets a private copy of the
 * stored list, may run more than once, and returns the list to store.
 * Throwing from it writes nothing. The cache is refreshed after the write.
 *
 * @param {(providers: Object[]) => Object[]} mutate
 * @returns {Promise<void>}
 */
async function updateProviders(mutate) {
  await configStore.updateJson(PROVIDERS_FILE, stored => ({
    providers: mutate(storedProviderList(stored))
  }));
  await configCache.refreshProvidersCache();
}

/** Most picks one sync request may carry: as many as a listing is read with. */
const MAX_SYNC_PICKS = MAX_MODELS;

/**
 * The picks of a sync request: `{ items: [{ kind, remoteId, modelId? }] }`. A `changed` or
 * `removed` pick names the iHub model in `modelId`: several iHub models can share one remote id.
 *
 * @throws {ServiceError} `BAD_REQUEST` for anything else
 */
function picksOf(body) {
  const list = body?.items;
  if (!Array.isArray(list) || list.length > MAX_SYNC_PICKS) {
    throw new ServiceError(
      'BAD_REQUEST',
      `items must be a list of at most ${MAX_SYNC_PICKS} picks`
    );
  }
  const textOf = (value, max) =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  for (const pick of list) {
    const kind = pick?.kind;
    const valid =
      pick &&
      typeof pick === 'object' &&
      ['added', 'changed', 'removed'].includes(kind) &&
      textOf(pick.remoteId, 200) &&
      (kind === 'added' ? pick.modelId === undefined : textOf(pick.modelId, 100));
    if (!valid) {
      throw new ServiceError(
        'BAD_REQUEST',
        'Each pick needs a kind and a remoteId, and a changed or removed pick the modelId of the model'
      );
    }
  }
  return list.map(({ kind, remoteId, modelId }) => ({
    kind,
    remoteId,
    ...(modelId ? { modelId } : {})
  }));
}

export default function registerAdminProvidersRoutes(app) {
  /**
   * @swagger
   * /admin/providers:
   *   get:
   *     summary: Get all providers (Admin)
   *     description: Retrieves all configured providers with API key status
   *     tags:
   *       - Admin - Providers
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: List of all providers
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/providers'), adminAuth, async (req, res) => {
    const { data: providers, etag: providersEtag } = configCache.getProviders(true);

    // Mask API keys in the response for security
    const maskedProviders = providers.map(provider => {
      const maskedProvider = { ...provider };
      if (maskedProvider.apiKey) {
        // Show masked value to indicate a key is set
        maskedProvider.apiKeyMasked = '••••••••';
        maskedProvider.apiKeySet = true;
        // Remove the actual encrypted key from response
        delete maskedProvider.apiKey;
      } else {
        maskedProvider.apiKeySet = false;
      }
      return maskedProvider;
    });

    res.setHeader('ETag', responseEtag(providersEtag));
    res.json({ items: maskedProviders });
  });

  /**
   * Adapter-declared provider config schema. Drives dynamic field rendering
   * in the admin Model Form Editor for provider-specific knobs (e.g. AWS
   * Bedrock region). Returns `{ fields: [] }` for providers that don't
   * declare a schema, so callers can safely render an empty section.
   */
  app.get(
    buildServerPath('/api/admin/providers/:providerId/schema'),
    adminAuth,
    async (req, res) => {
      const { providerId } = req.params;
      assertValidId(providerId, 'provider');
      const schema = await getProviderConfigSchema(providerId);
      res.json(schema || { fields: [] });
    }
  );

  /**
   * @swagger
   * /admin/providers/{providerId}/_model-drift:
   *   get:
   *     summary: Compare a model gateway with the models imported from it (Admin)
   *     description: |
   *       Reads the model listing of an iFinder Model Gateway provider (its base URL
   *       and stored project key) and compares it with the models linked to the
   *       provider. Changes nothing: every item names what an admin could do. To apply
   *       a choice, send it to `POST /admin/providers/{providerId}/_sync-models`; do not
   *       replay it through the model endpoints, which read the config cache and can
   *       write back a stale copy.
   *
   *       Item kinds: `added` (listed, not imported; `model` is a preview of the config
   *       that would be created, the sync builds it again from a fresh listing),
   *       `changed` (an imported model differs from the gateway; carries `changes` as
   *       `{ field, from, to }`), `removed` (an enabled imported model the gateway no
   *       longer lists, or lists as something iHub cannot run; `reason` is `missing` or
   *       `unsupported`; the offer is to disable it).
   *
   *       `changed` and `removed` items name the iHub model in `modelId`. Several iHub
   *       models can share one `remoteId` (a clone keeps it), each is its own item.
   *     tags:
   *       - Admin - Providers
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: providerId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The drift report; `items` is empty when everything matches
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 modelsUrl:
   *                   type: string
   *                 items:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       kind:
   *                         type: string
   *                         enum: [added, changed, removed]
   *                       remoteId:
   *                         type: string
   *                       modelId:
   *                         type: string
   *                         description: The iHub model (changed and removed)
   *                       name:
   *                         type: string
   *                         description: Display name (added)
   *                       model:
   *                         type: object
   *                         description: Model config to create (added)
   *                       reason:
   *                         type: string
   *                         enum: [missing, unsupported]
   *                       changes:
   *                         type: array
   *                         items:
   *                           type: object
   *                           properties:
   *                             field:
   *                               type: string
   *                             from: {}
   *                             to: {}
   *       400:
   *         description: "`BAD_REQUEST`: the provider is not a model gateway, has no base URL, or its URL is unusable"
   *       401:
   *         description: Admin authentication required
   *       404:
   *         description: "`NOT_FOUND`: no such provider"
   *       502:
   *         description: "`UPSTREAM_ERROR`: the gateway could not be reached or rejected the request; `details.reason` names why (`authenticationFailed`, `apiKeyRequired`, `connectionRefused`, …)"
   */
  app.get(
    buildServerPath('/api/admin/providers/:providerId/_model-drift'),
    adminAuth,
    async (req, res) => {
      const { modelsUrl, items } = await loadGatewayDrift(req.params.providerId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ modelsUrl, items });
    }
  );

  /**
   * @swagger
   * /admin/providers/{providerId}/_sync-models:
   *   post:
   *     summary: Apply a pick of the gateway drift to the models (Admin)
   *     description: |
   *       Applies the items an admin picked from `GET /admin/providers/{providerId}/_model-drift`.
   *       The server asks the gateway again and applies only picks that still match what it
   *       reports now; it never takes a model config from the request. `added` creates the
   *       model, `changed` sets the changed fields on the stored model, `removed` disables
   *       the model (it is never deleted). A `changed` or `removed` pick names the iHub
   *       model in `modelId`, because several iHub models can share one `remoteId`.
   *
   *       The request succeeds as a whole when it is understood: each item has its own
   *       outcome, and one failure does not stop the others.
   *     tags:
   *       - Admin - Providers
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: providerId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [items]
   *             properties:
   *               items:
   *                 type: array
   *                 maxItems: 5000
   *                 items:
   *                   type: object
   *                   required: [kind, remoteId]
   *                   properties:
   *                     kind:
   *                       type: string
   *                       enum: [added, changed, removed]
   *                     remoteId:
   *                       type: string
   *                     modelId:
   *                       type: string
   *                       description: The iHub model; required for `changed` and `removed`
   *     responses:
   *       200:
   *         description: One outcome per picked item, in the order they were applied
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 items:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       kind:
   *                         type: string
   *                       remoteId:
   *                         type: string
   *                       modelId:
   *                         type: string
   *                       status:
   *                         type: string
   *                         enum: [applied, skipped, failed]
   *                       detail:
   *                         type: string
   *                         description: "Why an item was not applied; `changedSinceReview` for a skipped one"
   *       400:
   *         description: "`BAD_REQUEST`: the body is not a list of picks, or the provider is not a model gateway or has no base URL"
   *       401:
   *         description: Admin authentication required
   *       404:
   *         description: "`NOT_FOUND`: no such provider"
   *       502:
   *         description: "`UPSTREAM_ERROR`: the gateway could not be asked; nothing was changed"
   */
  app.post(
    buildServerPath('/api/admin/providers/:providerId/_sync-models'),
    adminAuth,
    async (req, res) => {
      const picks = picksOf(req.body);
      const { items } = await loadGatewayDrift(req.params.providerId);
      const admin = req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown';

      const results = await applyGatewayDrift({
        picks,
        items,
        store: {
          ...modelStore,
          audit: (action, id, summary) =>
            logAudit({ req, action, resource: 'model', resourceId: id, summary }),
          snapshot: (id, before, after) =>
            saveSnapshot({ resource: 'model', id, before, after, admin })
        }
      });
      // One refresh for the whole batch, after every file is written.
      if (results.some(result => result.status === 'applied')) {
        await configCache.refreshModelsCache();
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: results });
    }
  );

  /**
   * Whether each provider entry has a usable API key — see
   * `GET /api/admin/models/_key-status`. The key itself is never returned.
   */
  app.get(buildServerPath('/api/admin/providers/_key-status'), adminAuth, async (req, res) => {
    const { data: providers } = configCache.getProviders(true);
    // LLM providers only: other categories (web search, …) read their keys
    // from places this check does not cover, so a verdict would mislead.
    const items = providers
      .filter(p => BUILT_IN_LLM_PROVIDERS.includes(p.id) || p.category === 'llm')
      .map(provider => ({ id: provider.id, ...inspectProviderApiKey(provider) }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items });
  });

  app.get(buildServerPath('/api/admin/providers/:providerId'), adminAuth, async (req, res) => {
    const { providerId } = req.params;

    // Validate providerId for security
    assertValidId(providerId, 'provider');

    const { data: providers, etag: providersEtag } = configCache.getProviders(true);
    const provider = providers.find(p => p.id === providerId);
    if (!provider) {
      throw new ServiceError('NOT_FOUND', 'Provider not found');
    }

    // Mask API key in the response for security
    const maskedProvider = { ...provider };
    if (maskedProvider.apiKey) {
      // Show masked value to indicate a key is set
      maskedProvider.apiKeyMasked = '••••••••';
      maskedProvider.apiKeySet = true;
      // Remove the actual encrypted key from response
      delete maskedProvider.apiKey;
    } else {
      maskedProvider.apiKeySet = false;
    }

    res.setHeader('ETag', responseEtag(providersEtag));
    res.json(maskedProvider);
  });

  app.put(buildServerPath('/api/admin/providers/:providerId'), adminAuth, async (req, res) => {
    const { providerId } = req.params;
    const updatedProvider = req.body;

    // Validate providerId for security
    assertValidId(providerId, 'provider');

    if (updatedProvider.id !== providerId) {
      throw new ServiceError('BAD_REQUEST', 'Provider ID cannot be changed');
    }

    // A new key is encrypted before the locked step; a masked placeholder
    // takes the stored key inside it, so a key saved meanwhile is not lost.
    const MASK = '••••••••';
    const keepStoredKey = updatedProvider.apiKey === MASK;
    if (updatedProvider.apiKey && !keepStoredKey) {
      updatedProvider.apiKey = tokenStorageService.encryptString(updatedProvider.apiKey);
    }

    let savedProvider;
    await updateProviders(providers => {
      // Work on a copy: the body is reused if the step has to run again.
      const next = { ...updatedProvider };

      // Find and update the provider
      const index = providers.findIndex(p => p.id === providerId);
      if (index === -1) {
        throw new ServiceError('NOT_FOUND', 'Provider not found');
      }

      if (keepStoredKey) {
        // The stored file, not the cache, holds the apiKey field.
        if (providers[index].apiKey) {
          // Preserve the existing encrypted API key
          next.apiKey = providers[index].apiKey;
        } else {
          // Nothing stored to preserve, drop the masked placeholder
          delete next.apiKey;
        }
      }

      // Remove client-side helper fields
      delete next.apiKeySet;
      delete next.apiKeyMasked;

      // The category decides which fields an entry has; it is fixed at creation.
      if (providers[index].category !== undefined) {
        next.category = providers[index].category;
      } else {
        delete next.category;
      }
      const validationError = normalizeProviderFields(next);
      if (validationError) {
        throw new ServiceError('BAD_REQUEST', validationError);
      }

      // A gateway provider's models speak different dialects (Mistral next to
      // OpenAI, a realtime speech backend). Taking the gateway setting away would
      // move them all to the provider's one API type — a realtime model would end
      // up on the OpenAI batch transcriber — so refuse while that would happen.
      if (isGatewayProvider(providers[index]) && !isGatewayProvider(next)) {
        const { data: models = [] } = configCache.getModels(true);
        const apiType = getProviderApiType(next);
        const affected = getLinkedModels(providerId, models).filter(
          model => linkedModelProvider(apiType, model) !== model.provider
        );
        if (affected.length > 0) {
          throw new ServiceError(
            'BAD_REQUEST',
            `Provider "${providerId}" is a model gateway and ${affected.length} of its models use their own API type. Delete or relink them before removing the gateway setting.`
          );
        }
      }

      providers[index] = next;
      savedProvider = next;
      return providers;
    });
    const updatedModels = await syncLinkedModelsApiType(savedProvider);

    res.json({
      provider: savedProvider,
      updatedModels
    });
  });

  /**
   * @swagger
   * /admin/providers:
   *   post:
   *     summary: Create a new provider (Admin)
   *     description: Creates a new provider configuration
   *     tags:
   *       - Admin - Providers
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       201:
   *         description: Provider created successfully
   *       400:
   *         description: Invalid request or provider already exists
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/admin/providers'), adminAuth, async (req, res) => {
    const newProvider = req.body;

    // Validate required fields
    if (!newProvider.id) {
      throw new ServiceError('BAD_REQUEST', 'Missing required field: id');
    }

    // Validate providerId for security
    assertValidId(newProvider.id, 'provider');

    if (isReservedProviderId(newProvider.id)) {
      throw new ServiceError(
        'BAD_REQUEST',
        `Provider ID '${newProvider.id}' is reserved for an API type. Choose another ID.`
      );
    }

    if (!newProvider.category) {
      newProvider.category = 'custom';
    }
    if (!PROVIDER_CATEGORIES.includes(newProvider.category)) {
      throw new ServiceError(
        'BAD_REQUEST',
        `Category must be one of: ${PROVIDER_CATEGORIES.join(', ')}`
      );
    }
    const validationError = normalizeProviderFields(newProvider);
    if (validationError) {
      throw new ServiceError('BAD_REQUEST', validationError);
    }

    // Handle API key encryption
    if (newProvider.apiKey && newProvider.apiKey !== '••••••••') {
      newProvider.apiKey = tokenStorageService.encryptString(newProvider.apiKey);
    } else {
      delete newProvider.apiKey;
    }

    // Remove client-side helper fields
    delete newProvider.apiKeySet;
    delete newProvider.apiKeyMasked;

    // Set defaults
    if (newProvider.enabled === undefined) {
      newProvider.enabled = true;
    }

    // Nothing readable means nothing configured yet, which is the first-run
    // case for a custom provider. The existence check and the write are one
    // locked step, so two creates of the same id cannot both pass it.
    await updateProviders(providers => {
      // Check if provider with this ID already exists
      if (providers.find(p => p.id === newProvider.id)) {
        throw new ServiceError(
          'BAD_REQUEST',
          `Provider with id '${newProvider.id}' already exists`
        );
      }
      providers.push(newProvider);
      return providers;
    });

    sendCreated(res, `/api/admin/providers/${segment(newProvider.id)}`, newProvider);
  });

  /**
   * @swagger
   * /admin/providers/{providerId}:
   *   delete:
   *     summary: Delete a provider (Admin)
   *     description: Deletes a provider configuration. Cannot delete built-in LLM providers.
   *     tags:
   *       - Admin - Providers
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - name: providerId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Provider deleted successfully
   *       400:
   *         description: Cannot delete built-in provider
   *       404:
   *         description: Provider not found
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.delete(buildServerPath('/api/admin/providers/:providerId'), adminAuth, async (req, res) => {
    const { providerId } = req.params;

    // Validate providerId for security
    assertValidId(providerId, 'provider');

    // Prevent deletion of built-in LLM providers
    if (BUILT_IN_LLM_PROVIDERS.includes(providerId)) {
      throw new ServiceError(
        'BAD_REQUEST',
        `Cannot delete built-in provider '${providerId}'. Only custom providers can be deleted.`
      );
    }

    // A provider still holding the key of some models cannot go: they would
    // silently fall back to another key, or to none.
    const { data: models = [] } = configCache.getModels(true);
    const linkedModels = getLinkedModels(providerId, models).map(m => m.id);
    if (linkedModels.length > 0) {
      throw new ServiceError(
        'PROVIDER_IN_USE',
        `Provider '${providerId}' is used by ${linkedModels.length} model(s). Delete them or move them to another provider first.`,
        { details: { linkedModels } }
      );
    }

    await updateProviders(providers => {
      // Find provider index
      const index = providers.findIndex(p => p.id === providerId);
      if (index === -1) {
        throw new ServiceError('NOT_FOUND', 'Provider not found');
      }

      // Remove provider
      providers.splice(index, 1);
      return providers;
    });

    res.status(204).end();
  });
}
