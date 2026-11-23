// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedContent } from '../../../shared/localize.js';
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { responseEtag } from '../../utils/etag.js';
import { assertValidId, assertValidIds } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { isApiErrorCode } from '../../../shared/apiErrors.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import logger from '../../utils/logger.js';
import { removeMarketplaceInstallation } from '../../utils/installationCleanup.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import { compareByOrderThenName } from '../../utils/resourceLoader.js';
import llmClient, { isLLMError } from '../../services/loop/LLMClient.js';
import { getTtsProvider, isTtsModel } from '../../tts/index.js';
import { isTranscriptionModel } from '../../transcription/index.js';
import { testTranscriptionModel } from '../../websocket/realtimeTranscription.js';
import { TTS_LANGUAGES } from '../../tts/language.js';
import { llmErrorToHttpStatus } from '../../services/loop/llmHttpErrors.js';
import { describeLlmFailure } from '../../services/loop/llmFailureCause.js';
import { discoverModels, comparableUrl } from '../../services/ModelEndpointDiscovery.js';
import { BEDROCK_API_TYPE, discoverBedrockModels } from '../../services/BedrockModelDiscovery.js';
import { DEFAULT_BEDROCK_REGION, isValidBedrockRegion } from '../../../shared/bedrockRegions.js';
import {
  BUILT_IN_LLM_PROVIDERS,
  gatewayModelProvider,
  getProviderApiType,
  isGatewayProvider,
  linkedModelProvider,
  resolveProviderApiKey
} from '../../services/llmProviders.js';
import { inspectModelApiKey } from '../../utils.js';
import { usageLimitBucketSchema } from '../../validators/common.js';
import { sendCreated, segment } from '../../utils/created.js';
import { effectiveDefaultModelId, findModelDependants } from '../../utils/resourceDependants.js';

/** Largest voice sample accepted (Mistral needs seconds, not minutes, of audio). */
const MAX_VOICE_SAMPLE_BYTES = 10 * 1024 * 1024;
/** Audio file types a voice sample may have. */
const VOICE_SAMPLE_EXTENSIONS = new Set([
  'wav',
  'mp3',
  'm4a',
  'ogg',
  'oga',
  'opus',
  'flac',
  'webm'
]);

/**
 * The TTS model and its provider for a voices request. Throws the error response when there is
 * none. Disabled models are allowed, so voices can be set up before enabling.
 */
function resolveVoicesModel(req) {
  const { modelId } = req.params;
  assertValidId(modelId, 'model');
  const { data: models } = configCache.getModels(true);
  const model = models.find(m => m.id === modelId);
  if (!model) {
    throw new ServiceError('NOT_FOUND', 'Model not found');
  }
  if (!isTtsModel(model)) {
    throw new ServiceError('NOT_TTS_MODEL', 'Not a text-to-speech model');
  }
  const provider = getTtsProvider(model.provider);
  if (!provider?.listVoices) {
    throw new ServiceError(
      'VOICES_UNSUPPORTED',
      `Provider "${model.provider}" does not manage voices`
    );
  }
  return { model, provider, cfg: provider.resolveUpstream(model) };
}

/**
 * The error a failed upstream voices call becomes. Upstream failures carry a safe message;
 * anything else stays in the log.
 *
 * @param {Error} error - What the provider threw
 * @param {string} action - What was attempted ("list voices")
 * @returns {ServiceError} `UPSTREAM_ERROR` (502)
 */
function voicesError(error, action) {
  logger.error(`Text-to-speech voices: ${action} failed`, {
    component: 'ModelsRoutes',
    upstreamStatus: error.status,
    error: error.message
  });
  const message = error.name === 'TtsUpstreamError' ? error.message : `Could not ${action}`;
  return new ServiceError('UPSTREAM_ERROR', message, { cause: error });
}

/**
 * The file a model id lives in.
 *
 * A model file's name is allowed to diverge from the `id` inside it, so the
 * path is resolved instead of assumed: writing straight to `<id>.json` would
 * fork such a model into two files. A model that exists nowhere resolves to
 * `<id>.json`, which is the right answer when one is being created.
 *
 * @param {string} modelId - Model id
 * @returns {Promise<string|null>} Path relative to `contents/`, or null when
 *   the id is not usable as a file name
 */
/**
 * The `_discover` answer for a listing: the entries, each flagged with the iHub
 * model that already points at it (`existingModelId`), so the admin does not
 * import a model twice. A model "points at" a listed one when it has the same
 * remote model id on the same endpoint; Bedrock models have no URL (the adapter
 * builds it from the region), so there the remote id among the Bedrock models counts.
 *
 * @param {Object} result - `discoverModels` / `discoverBedrockModels` result
 * @returns {Object} Response body
 */
function withExistingModels(result) {
  const { data: configured = [] } = configCache.getModels(true);
  const bedrock = result.provider === BEDROCK_API_TYPE;
  const keyOf = (modelId, url) => (bedrock ? modelId : `${modelId}\n${comparableUrl(url)}`);
  const existing = new Map();
  for (const model of configured) {
    if (bedrock && model.provider !== BEDROCK_API_TYPE) continue;
    existing.set(keyOf(model.modelId, model.url), model.id);
  }
  return {
    apiType: result.provider,
    modelsUrl: result.modelsUrl,
    baseUrl: result.baseUrl,
    azure: result.azure,
    gateway: result.gateway || null,
    ...(result.region ? { region: result.region } : {}),
    models: result.models.map(model => ({
      ...model,
      existingModelId: existing.get(keyOf(model.id, model.url)) || null
    }))
  };
}

function modelPath(modelId) {
  return configStore.resolveIdToPath('models', modelId);
}

/** Prompt sent by the admin "test model" diagnostic. */
const MODEL_TEST_MESSAGE = 'Hello, can you respond with a simple "Test successful" message?';

/** Hard cap for one model test call (interactive admin request). */
const MODEL_TEST_TIMEOUT_MS = 60000;

/**
 * Bring a model's link to a provider entry in line with that entry, in place:
 * the model's `provider` becomes the entry's API type (a Google transcription
 * model keeps its speech backend, see linkedModelProvider), and a link to a built-in
 * entry (`providerId: "openai"`) is dropped, since the model reaches it through
 * its API type anyway. A link to a custom entry is always kept. A model
 * therefore cannot claim one API type while its provider declares another —
 * except on a gateway provider, whose models keep the adapter of their own
 * dialect (Mistral next to OpenAI, see gatewayModelProvider).
 *
 * @param {Object} model - Model config from the request body
 * @returns {string|null} Error message for a link that cannot be honoured
 */
function applyProviderLink(model) {
  if (model.providerId === undefined || model.providerId === null || model.providerId === '') {
    delete model.providerId;
    return null;
  }
  if (typeof model.providerId !== 'string') {
    return 'Invalid providerId';
  }
  const { data: providers = [] } = configCache.getProviders(true);
  const providerEntry = providers.find(p => p.id === model.providerId);
  const apiType = getProviderApiType(providerEntry);
  if (!apiType) {
    return `Provider "${model.providerId}" does not exist or is not an LLM provider`;
  }
  model.provider = isGatewayProvider(providerEntry)
    ? gatewayModelProvider(apiType, model)
    : linkedModelProvider(apiType, model);
  if (BUILT_IN_LLM_PROVIDERS.includes(model.providerId)) {
    delete model.providerId;
  }
  return null;
}

export { applyProviderLink };

/**
 * Only a chat model can be the default (see `resourceLoaders.js`): a TTS or
 * transcription model never takes the flag, nor the flag from the chat model
 * it would replace.
 */
const isChatModel = model => (model.modelType || 'chat') === 'chat';

/**
 * The model files as they are on disk now, in the order the config cache lists them.
 *
 * A route that rewrites a model it did not just receive from the client has to start
 * from the file, never from the config cache. The cache of another worker can still
 * hold the version before a save that has just been acknowledged, and rewriting that copy
 * writes the old version back over the save. The cache's objects are also shared with every
 * reader in the process, so a route must not change them in place before the write succeeds.
 *
 * @returns {Promise<Object[]>}
 */
async function storedModels() {
  const documents = await configStore.listDocuments('models');
  return documents.map(document => document.data).sort(compareByOrderThenName);
}

/**
 * Change one stored model: read its file, apply `change` to a copy, write it back.
 *
 * @param {string} modelId
 * @param {(model: Object) => Object} change - Returns the new version of the model
 * @returns {Promise<Object|null>} The model as written, or null when it has no file
 */
async function updateStoredModel(modelId, change) {
  const file = await modelPath(modelId);
  // updateJson holds the file's lock (or the provider's compare-and-set) from the read to the
  // write, so a save of the same model in between is not written over. `change` may run again.
  const { data } = await configStore.updateJson(file, stored =>
    stored === null ? undefined : change({ ...stored })
  );
  return data;
}

/** Take the default flag off every stored model except `exceptId`. */
async function clearOtherDefaults(exceptId) {
  for (const model of await storedModels()) {
    if (model.id !== exceptId && model.default === true) {
      await updateStoredModel(model.id, stored => ({ ...stored, default: false }));
    }
  }
}

/**
 * Make sure one enabled chat model is the default, deciding from the stored files.
 * The config loader repairs a missing default in memory too, but a stored one survives a
 * reorder and is the same on every worker.
 *
 * @param {string} [exceptId] - A model about to go away, never promoted
 */
async function ensureStoredDefault(exceptId) {
  const candidates = (await storedModels()).filter(
    model => model.id !== exceptId && model.enabled !== false && isChatModel(model)
  );
  if (candidates.length > 0 && !candidates.some(model => model.default === true)) {
    await updateStoredModel(candidates[0].id, stored => ({ ...stored, default: true }));
  }
}

/**
 * Response header that names the model the server made the platform default on
 * its own, without the admin asking for it (AI-B13): the first enabled chat
 * model when there was none, or the next one when the default was disabled or
 * deleted. Sent by create, update, `_toggle` and delete (a `204` has no body, so a
 * body member could not carry it). The value is the model id, URI-encoded.
 */
export const DEFAULT_MODEL_ASSIGNED_HEADER = 'Default-Model-Assigned';

/** The model that answers when an app names none, as the config cache has it now. */
function liveDefaultModelId() {
  const { data = [] } = configCache.getModels(true);
  return effectiveDefaultModelId(data);
}

/**
 * Tell the admin when the default model changed to one they did not choose.
 * Call it after the models cache was refreshed.
 *
 * @param {import('express').Response} res
 * @param {string|null} previousId - The default before the change (`liveDefaultModelId()`)
 * @param {string|null} [chosenId] - The model the request itself made the default, if any
 */
function announceAssignedDefault(res, previousId, chosenId = null) {
  const currentId = liveDefaultModelId();
  if (currentId && currentId !== previousId && currentId !== chosenId) {
    res.setHeader(DEFAULT_MODEL_ASSIGNED_HEADER, encodeURIComponent(currentId));
  }
}

/**
 * Validate a model's per-user token budget (`usageLimits: { day, week, month }`)
 * in place: windows left empty or set to -1 are unlimited and are dropped, and
 * an empty budget is removed. Used by both create and update.
 *
 * @param {Object} model
 * @returns {string|null} An error message, or null when valid
 */
function normalizeModelUsageLimits(model) {
  if (model.usageLimits === undefined) return null;
  const parsed = usageLimitBucketSchema.safeParse(model.usageLimits || {});
  if (!parsed.success) return 'Invalid usageLimits';
  const limits = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined && v !== null && v >= 0)
  );
  if (Object.keys(limits).length) model.usageLimits = limits;
  else delete model.usageLimits;
  return null;
}

/**
 * Validate the region of a Bedrock model (`config.region`) in place: an empty
 * value is removed (the provider's region or the environment applies), a set
 * one is trimmed and must be an AWS region code or `global`. The adapter
 * refuses a set but invalid region at call time; refusing it on save tells
 * the admin before a user hits it. Other providers' `config` is not read.
 *
 * @param {Object} model
 * @returns {string|null} An error message, or null when valid
 */
function normalizeBedrockModelRegion(model) {
  if (model.provider !== 'bedrock') return null;
  const config = model.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  if (!('region' in config)) return null;
  const { region, ...rest } = config;
  if (region === undefined || region === null || region === '') {
    model.config = rest;
    return null;
  }
  const trimmed = typeof region === 'string' ? region.trim() : region;
  if (!isValidBedrockRegion(trimmed)) {
    return 'config.region must be an AWS region code such as eu-central-1, or global';
  }
  model.config = { ...rest, region: trimmed };
  return null;
}

export default function registerAdminModelsRoutes(app) {
  /**
   * @swagger
   * /admin/models:
   *   get:
   *     summary: Get all models (Admin)
   *     description: Retrieves all configured models including disabled ones (admin access required)
   *     tags:
   *       - Admin - Models
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: List of all models
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   id:
   *                     type: string
   *                   name:
   *                     type: string
   *                   provider:
   *                     type: string
   *                   enabled:
   *                     type: boolean
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/models'), adminAuth, async (req, res) => {
    const { data: models, etag: modelsEtag } = configCache.getModels(true);

    // Mask API keys in the response for security
    const maskedModels = models.map(model => {
      const maskedModel = { ...model };
      if (maskedModel.apiKey) {
        // Show masked value to indicate a key is set
        maskedModel.apiKeyMasked = '••••••••';
        maskedModel.apiKeySet = true;
        // Remove the actual encrypted key from response
        delete maskedModel.apiKey;
      } else {
        maskedModel.apiKeySet = false;
      }
      return maskedModel;
    });

    res.setHeader('ETag', responseEtag(modelsEtag));
    res.json({ items: maskedModels });
  });

  /**
   * @swagger
   * /admin/models/_discover:
   *   post:
   *     summary: List the models an endpoint offers (Admin)
   *     description: |
   *       Calls the `/models` listing behind a URL — OpenAI, Mistral, vLLM,
   *       LM Studio, T-Systems LLM Hub and other OpenAI-compatible servers,
   *       Anthropic or Google — and returns its entries normalized, so the
   *       admin can pick models to import. Nothing is stored. The URL may be
   *       the listing itself, the API base (`…/v1`) or an inference URL.
   *
   *       With `providerId`, the call uses that provider's API type, stored
   *       API key (or its environment variable) and, when `url` is empty, its
   *       `baseUrl` — the key never has to leave the server. Without it,
   *       `apiType` and an optional `apiKey` describe a provider that does
   *       not exist yet.
   *
   *       AWS Bedrock (`providerId: bedrock` or `apiType: bedrock`) is listed
   *       per region instead of per URL: `ListFoundationModels` and
   *       `ListInferenceProfiles` of `bedrock.<region>.amazonaws.com`, with the
   *       Bedrock API key as Bearer token. `region` is the AWS region (or
   *       `global`); without it the provider's `config.region`, then
   *       `AWS_REGION` / `AWS_DEFAULT_REGION`, then `eu-central-1` apply. A
   *       model that needs a cross-region inference profile is listed under
   *       the profile id; the answer then carries `region`.
   *
   *       A failure on the endpoint's side answers 502 (never 401, which would
   *       end the admin session) with `{ error, details, messageKey }`.
   *     tags:
   *       - Admin - Models
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               url:
   *                 type: string
   *                 example: https://llm-server.llmhub.t-systems.net/v2
   *               providerId:
   *                 type: string
   *                 description: Existing LLM provider whose API type and key are used
   *               apiType:
   *                 type: string
   *                 enum: [openai, openai-responses, mistral, local, anthropic, google, bedrock]
   *                 default: openai
   *               region:
   *                 type: string
   *                 example: eu-central-1
   *                 description: Bedrock only. AWS region code or `global`.
   *               gateway:
   *                 type: string
   *                 enum: [ifinder-model-gateway]
   *                 description: |
   *                   Set when the endpoint is an iFinder Model Gateway (for an existing
   *                   provider this is read from the provider entry). The listing is then
   *                   read from `/v1/gateway/models` and models are called on
   *                   `/v1/gateway/proxy/…`; `apiType` is `openai` or `local`.
   *               apiKey:
   *                 type: string
   *                 description: Optional. Sent only to this endpoint, never stored by this call.
   *     responses:
   *       200:
   *         description: Normalized model list
   *       400:
   *         description: Invalid URL, provider or API type
   *       502:
   *         description: The endpoint could not be reached or rejected the request
   */
  app.post(buildServerPath('/api/admin/models/_discover'), adminAuth, async (req, res) => {
    const { url, providerId, apiType = 'openai', apiKey, gateway, region } = req.body || {};
    if (url !== undefined && url !== null && typeof url !== 'string') {
      throw new ServiceError('BAD_REQUEST', 'Invalid URL');
    }
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') {
      throw new ServiceError('BAD_REQUEST', 'Invalid API key');
    }
    if (region !== undefined && region !== null && typeof region !== 'string') {
      throw new ServiceError('BAD_REQUEST', 'Invalid region');
    }

    let discoveryUrl = (url || '').trim();
    let discoveryApiType = apiType;
    // Set for an iFinder Model Gateway, which lists and serves models on routes of its own.
    let discoveryGateway = typeof gateway === 'string' && gateway ? gateway : undefined;
    let discoveryKey = (apiKey || '').trim();
    // Bedrock: the provider entry's region (`config.region`), read below.
    let providerRegion;

    if (providerId !== undefined && providerId !== null && providerId !== '') {
      assertValidId(providerId, 'provider');
      const { data: providers = [] } = configCache.getProviders(true);
      const providerEntry = providers.find(p => p.id === providerId);
      if (!providerEntry) {
        throw new ServiceError('NOT_FOUND', 'Provider not found');
      }
      discoveryApiType = getProviderApiType(providerEntry);
      discoveryGateway = isGatewayProvider(providerEntry) ? providerEntry.gateway : undefined;
      if (!discoveryApiType) {
        throw new ServiceError('BAD_REQUEST', `Provider "${providerId}" is not an LLM provider`);
      }
      if (!discoveryUrl) discoveryUrl = providerEntry.baseUrl || '';
      if (!discoveryKey) discoveryKey = resolveProviderApiKey(providerEntry) || '';
      providerRegion = providerEntry.config?.region;
    } else if (typeof apiType !== 'string') {
      throw new ServiceError('BAD_REQUEST', 'Invalid API type');
    }

    // Bedrock lists its models per AWS region, not behind a URL. The region is
    // the one typed in the wizard, else the provider's, else the environment's —
    // the order the adapter resolves it in.
    if (discoveryApiType === BEDROCK_API_TYPE) {
      const discoveryRegion =
        (region || '').trim() ||
        providerRegion ||
        process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION ||
        DEFAULT_BEDROCK_REGION;
      if (!isValidBedrockRegion(discoveryRegion)) {
        throw new ServiceError(
          'BAD_REQUEST',
          `"${String(discoveryRegion).slice(0, 40)}" is not an AWS region. Use a region code such as eu-central-1, or global.`
        );
      }
      const result = await discoverBedrockModels({ region: discoveryRegion, apiKey: discoveryKey });
      res.json(withExistingModels(result));
      return;
    }

    if (!discoveryUrl) {
      throw new ServiceError('BAD_REQUEST', 'URL is required');
    }

    const result = await discoverModels({
      url: discoveryUrl,
      provider: discoveryApiType,
      apiKey: discoveryKey,
      gateway: discoveryGateway
    });

    res.json(withExistingModels(result));
  });

  /**
   * @swagger
   * /admin/models/_key-status:
   *   get:
   *     summary: Whether each chat model has a usable API key (Admin)
   *     description: |
   *       For every chat model, where its API key comes from and whether it can
   *       be used. `state` is `ok` (a key is found), `keyless` (none, and the
   *       model runs without one — local servers), `undecryptable` (a key is
   *       stored but this server cannot decrypt it: the encryption key changed)
   *       or `missing`. `source` is `model`, `provider`, `env` or `none`. The
   *       key itself is never returned.
   *     tags:
   *       - Admin - Models
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: "{ items: [{ id, state, source, envVar, enabled }] }, one per chat model"
   *       401:
   *         description: Admin authentication required
   */
  app.get(buildServerPath('/api/admin/models/_key-status'), adminAuth, async (req, res) => {
    const { data: models } = configCache.getModels(true);
    const items = [];
    for (const model of models) {
      // Speech models resolve their credentials on their own path.
      if (!isChatModel(model)) continue;
      const enabled = model.enabled !== false;
      if (model.provider === 'iassistant-conversation') {
        items.push({ id: model.id, state: 'keyless', source: 'none', envVar: null, enabled });
        continue;
      }
      const { state, source, envVar } = inspectModelApiKey(model, { quiet: true });
      items.push({ id: model.id, state, source, envVar, enabled });
    }
    // Depends on providers and the environment as well as on the models, so
    // it must not ride on the models' ETag.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items });
  });

  app.get(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    const { modelId } = req.params;

    // Validate modelId for security
    assertValidId(modelId, 'model');

    const { data: models, etag: modelsEtag } = configCache.getModels(true);
    const model = models.find(m => m.id === modelId);
    if (!model) {
      throw new ServiceError('NOT_FOUND', 'Model not found');
    }

    // Mask API key in the response for security
    const maskedModel = { ...model };
    if (maskedModel.apiKey) {
      // Show masked value to indicate a key is set
      maskedModel.apiKeyMasked = '••••••••';
      maskedModel.apiKeySet = true;
      // Remove the actual encrypted key from response
      delete maskedModel.apiKey;
    } else {
      maskedModel.apiKeySet = false;
    }

    res.setHeader('ETag', responseEtag(modelsEtag));
    res.json(maskedModel);
  });

  app.put(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    const { modelId } = req.params;
    const updatedModel = req.body;

    // Validate modelId for security
    assertValidId(modelId, 'model');

    const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
    if (
      !updatedModel.id ||
      !getLocalizedContent(updatedModel.name, defaultLang) ||
      !getLocalizedContent(updatedModel.description, defaultLang) ||
      !updatedModel.provider
    ) {
      throw new ServiceError('BAD_REQUEST', 'Missing required fields');
    }
    if (updatedModel.id !== modelId) {
      throw new ServiceError('BAD_REQUEST', 'Model ID cannot be changed');
    }
    const providerLinkError = applyProviderLink(updatedModel);
    if (providerLinkError) {
      throw new ServiceError('BAD_REQUEST', providerLinkError);
    }

    // Handle API key encryption
    if (updatedModel.apiKey) {
      // Check if this is a new key or unchanged masked value
      if (updatedModel.apiKey !== '••••••••') {
        // New key provided - encrypt it
        updatedModel.apiKey = tokenStorageService.encryptString(updatedModel.apiKey);
      } else {
        // Masked value - need to preserve existing key
        // CRITICAL FIX: Read the stored document, not the cache, to ensure we
        // have the apiKey field. The cache might not have it due to TTL
        // expiration or race conditions.
        const storedModel = await configStore.readJson(await modelPath(modelId));
        if (storedModel?.apiKey) {
          // Preserve the existing encrypted API key
          updatedModel.apiKey = storedModel.apiKey;
        } else {
          // Nothing stored to preserve, drop the masked placeholder
          delete updatedModel.apiKey;
        }
      }
    }

    // Remove client-side helper fields
    delete updatedModel.apiKeySet;
    delete updatedModel.apiKeyMasked;

    const limitsError = normalizeModelUsageLimits(updatedModel);
    if (limitsError) throw new ServiceError('BAD_REQUEST', limitsError);
    const regionError = normalizeBedrockModelRegion(updatedModel);
    if (regionError) throw new ServiceError('BAD_REQUEST', regionError);

    // A disabled model answers nobody, so it cannot stay the default (the toggle
    // already clears it); the next enabled chat model takes over below.
    if (!isChatModel(updatedModel) || updatedModel.enabled === false) updatedModel.default = false;
    const previousDefaultId = liveDefaultModelId();
    if (updatedModel.default === true) await clearOtherDefaults(modelId);
    // The version being replaced, as it is stored: the history's "before". Replaced under the
    // same lock a toggle takes, so the two cannot interleave.
    let oldModel = null;
    await configStore.updateJson(await modelPath(modelId), current => {
      oldModel = current;
      return updatedModel;
    });
    if (oldModel?.default === true && updatedModel.default !== true) await ensureStoredDefault();
    await configCache.refreshModelsCache();
    if (oldModel) {
      await saveSnapshot({
        resource: 'model',
        id: modelId,
        before: oldModel,
        after: updatedModel,
        admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
      });
    }
    await logAudit({
      req,
      action: 'update',
      resource: 'model',
      resourceId: modelId,
      summary: `Updated model ${modelId}`
    });
    announceAssignedDefault(res, previousDefaultId, updatedModel.default === true ? modelId : null);
    res.json(updatedModel);
  });

  app.post(buildServerPath('/api/admin/models'), adminAuth, async (req, res) => {
    const newModel = req.body;
    const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
    if (
      !newModel.id ||
      !getLocalizedContent(newModel.name, defaultLang) ||
      !getLocalizedContent(newModel.description, defaultLang) ||
      !newModel.provider
    ) {
      throw new ServiceError('BAD_REQUEST', 'Missing required fields');
    }

    // Validate newModel.id for security
    assertValidId(newModel.id, 'model');
    const limitsError = normalizeModelUsageLimits(newModel);
    if (limitsError) throw new ServiceError('BAD_REQUEST', limitsError);
    const regionError = normalizeBedrockModelRegion(newModel);
    if (regionError) throw new ServiceError('BAD_REQUEST', regionError);

    const providerLinkError = applyProviderLink(newModel);
    if (providerLinkError) {
      throw new ServiceError('BAD_REQUEST', providerLinkError);
    }

    // Handle API key encryption
    if (newModel.apiKey && newModel.apiKey !== '••••••••') {
      // New key provided - encrypt it
      newModel.apiKey = tokenStorageService.encryptString(newModel.apiKey);
    } else if (newModel.apiKey === '••••••••') {
      // Remove masked placeholder if no real key
      delete newModel.apiKey;
    }

    // Remove client-side helper fields
    delete newModel.apiKeySet;
    delete newModel.apiKeyMasked;

    // The duplicate check stays ahead of the default-demotion below: a 409
    // must not leave every other model stripped of its default flag.
    const newModelPath = `models/${newModel.id}.json`;
    if ((await configStore.readJson(newModelPath)) !== null) {
      throw new ServiceError('CONFLICT', 'Model with this ID already exists');
    }
    if (!isChatModel(newModel) || newModel.enabled === false) newModel.default = false;
    const previousDefaultId = liveDefaultModelId();
    if (newModel.default === true) await clearOtherDefaults(newModel.id);
    await configStore.writeJson(newModelPath, newModel);
    await configCache.refreshModelsCache();
    await logAudit({
      req,
      action: 'create',
      resource: 'model',
      resourceId: newModel.id,
      summary: `Created model ${newModel.id}`
    });
    announceAssignedDefault(res, previousDefaultId, newModel.default === true ? newModel.id : null);
    sendCreated(res, `/api/admin/models/${segment(newModel.id)}`, newModel);
  });

  /**
   * @swagger
   * /admin/models/{modelIds}/_toggle:
   *   post:
   *     summary: Enable or disable models (Admin)
   *     description: |
   *       Sets `enabled` on the models named (comma-separated, or `*` for all). A disabled
   *       model loses the default flag; when no enabled chat model is the default afterwards,
   *       the first one becomes it, and the `Default-Model-Assigned` header names it.
   *       Create, update and delete send the same header when they make the server pick a
   *       new default.
   *     tags:
   *       - Admin - Models
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [enabled]
   *             properties:
   *               enabled: { type: boolean }
   *     responses:
   *       200:
   *         description: The state set and the ids it was set on
   *         headers:
   *           Default-Model-Assigned:
   *             description: URI-encoded id of the model the server made the default on its own
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 enabled: { type: boolean }
   *                 ids: { type: array, items: { type: string } }
   *       400:
   *         description: "`BAD_REQUEST`: missing flag or invalid id"
   */
  app.post(buildServerPath('/api/admin/models/:modelIds/_toggle'), adminAuth, async (req, res) => {
    const { modelIds } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      throw new ServiceError('BAD_REQUEST', 'Missing enabled flag');
    }

    // Validate modelIds for security
    const ids = assertValidIds(modelIds, 'model');

    const resolvedIds = ids.includes('*') ? (await storedModels()).map(m => m.id) : ids;
    const previousDefaultId = liveDefaultModelId();

    for (const id of resolvedIds) {
      await updateStoredModel(id, stored => ({
        ...stored,
        enabled,
        ...(enabled ? {} : { default: false })
      }));
    }

    // ensure at least one enabled model has default=true
    await ensureStoredDefault();

    await configCache.refreshModelsCache();
    await logAudit({
      req,
      action: 'toggle',
      resource: 'model',
      resourceId: resolvedIds.join(','),
      summary: `Batch ${enabled ? 'enabled' : 'disabled'} ${resolvedIds.length} models`
    });
    announceAssignedDefault(res, previousDefaultId);
    res.json({
      enabled,
      ids: resolvedIds
    });
  });

  app.delete(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    const { modelId } = req.params;

    // Validate modelId for security
    assertValidId(modelId, 'model');

    const model = await configStore.readJson(await modelPath(modelId));
    if (!model) {
      throw new ServiceError('NOT_FOUND', 'Model not found');
    }
    const previousDefaultId = liveDefaultModelId();
    if (model.default === true) await ensureStoredDefault(modelId);
    if (!(await configStore.remove(await modelPath(modelId)))) {
      throw new ServiceError('NOT_FOUND', 'Model file not found');
    }
    await configCache.refreshModelsCache();
    await removeMarketplaceInstallation('model', modelId);
    if (model) {
      await saveSnapshot({
        resource: 'model',
        id: modelId,
        before: model,
        after: null,
        admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
      });
    }
    await logAudit({
      req,
      action: 'delete',
      resource: 'model',
      resourceId: modelId,
      summary: `Deleted model ${modelId}`
    });
    announceAssignedDefault(res, previousDefaultId);
    res.status(204).end();
  });

  /**
   * @swagger
   * /admin/models/{modelId}/_dependants:
   *   get:
   *     summary: What refers to a model (Admin)
   *     description: |
   *       Read-only. Lists what names the model, so the delete dialog can say what loses
   *       its reference before the model is deleted. Nothing here blocks a delete: an app
   *       whose model is gone falls back to the default model, a group entry naming no
   *       model grants nothing. A delete keeps a copy in the change history, from which
   *       the model can be restored.
   *     tags:
   *       - Admin - Models
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: modelId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The references
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 apps:
   *                   type: array
   *                   description: Apps naming the model
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { description: "Localized name object or text" }
   *                       references:
   *                         type: array
   *                         items:
   *                           type: string
   *                           enum: [preferredModel, allowedModels, speechRecognition, voiceMode]
   *                 workflows:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { description: "Localized name object or text" }
   *                       references:
   *                         type: array
   *                         items: { type: string, enum: [defaultModel, node] }
   *                 groups:
   *                   type: array
   *                   description: Groups whose model permissions list the model by id
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                 isDefault:
   *                   type: boolean
   *                   description: The model is the platform default
   *                 nextDefaultModelId:
   *                   type: string
   *                   description: With isDefault, the model that becomes the default; absent when none can
   *       400:
   *         description: "`BAD_REQUEST`: invalid model id"
   *       404:
   *         description: "`NOT_FOUND`: no such model"
   */
  app.get(
    buildServerPath('/api/admin/models/:modelId/_dependants'),
    adminAuth,
    async (req, res) => {
      const { modelId } = req.params;
      assertValidId(modelId, 'model');
      const { data: models = [] } = configCache.getModels(true);
      if (!models.some(model => model.id === modelId)) {
        throw new ServiceError('NOT_FOUND', 'Model not found');
      }
      const dependants = findModelDependants(modelId, {
        apps: configCache.getApps(true)?.data ?? [],
        workflows: configCache.getWorkflows(true)?.data ?? [],
        agents: configCache.getAgentProfiles?.(true)?.data ?? [],
        // The authored file: the cache's groups carry their parents' permissions as their own.
        groupsConfig: await configStore.readJson('config/groups.json').catch(() => null),
        models
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(dependants);
    }
  );

  /**
   * @swagger
   * /admin/models/{modelId}/_make-default:
   *   post:
   *     summary: Make a model the platform default (Admin)
   *     description: |
   *       The model answers in every app that names no model of its own. Only an enabled
   *       chat model can be the default; the flag is taken off every other model.
   *     tags:
   *       - Admin - Models
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: modelId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The model as stored now, with `default` true (API key masked)
   *       400:
   *         description: "`BAD_REQUEST`: invalid id, or not a chat model"
   *       404:
   *         description: "`NOT_FOUND`: no such model"
   *       409:
   *         description: "`CONFLICT`: the model is disabled; enable it first"
   */
  app.post(
    buildServerPath('/api/admin/models/:modelId/_make-default'),
    adminAuth,
    async (req, res) => {
      const { modelId } = req.params;
      assertValidId(modelId, 'model');
      const file = await modelPath(modelId);
      const stored = await configStore.readJson(file);
      if (!stored) throw new ServiceError('NOT_FOUND', 'Model not found');
      if (!isChatModel(stored)) {
        throw new ServiceError('BAD_REQUEST', 'Only a chat model can be the default model');
      }
      if (stored.enabled === false) {
        throw new ServiceError('CONFLICT', 'The model is disabled. Enable it first.');
      }
      await clearOtherDefaults(modelId);
      const updated = await updateStoredModel(modelId, current => ({ ...current, default: true }));
      await configCache.refreshModelsCache();
      await logAudit({
        req,
        action: 'update',
        resource: 'model',
        resourceId: modelId,
        summary: `Made model ${modelId} the default`
      });
      const { apiKey, ...visible } = updated || { ...stored, default: true };
      res.json(
        apiKey
          ? { ...visible, apiKeySet: true, apiKeyMasked: '••••••••' }
          : { ...visible, apiKeySet: false }
      );
    }
  );

  /**
   * POST /api/admin/models/:modelId/_test
   *
   * Connectivity / credential diagnostic for one configured model. Disabled
   * models are included so an admin can verify a model before enabling it.
   * The call goes through `LLMClient` and is recorded in the run ledger as a
   * `diagnostic` run. Failures answer with a non-2xx status derived from the
   * `LLMError` code and a problem body whose `details` hold `messageKey` (the
   * cause the admin UI translates), `remediation` (English fallback text) and,
   * when known, `upstreamStatus`, `host` and `errorCode` (socket or TLS code).
   */
  /**
   * Synthesize one short sentence with a TTS model and report how much audio
   * came back. Same response shape as a chat model test; `response` names the
   * audio length and voice instead of an answer.
   */
  async function testTtsModel(model, res) {
    const safeModel = { ...model };
    delete safeModel.apiKey;
    const provider = getTtsProvider(model.provider);
    if (!provider) {
      throw new ServiceError(
        'UNSUPPORTED_TTS_PROVIDER',
        `Unsupported text-to-speech provider: ${model.provider}`
      );
    }
    const cfg = provider.resolveUpstream(model);
    let bytes = 0;
    try {
      await provider.synthesize({
        cfg,
        text: 'This is a test of the text to speech model.',
        signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
        onAudio: pcm => {
          bytes += pcm.length;
        }
      });
    } catch (error) {
      logger.error('Text-to-speech model test failed', {
        component: 'ModelsRoutes',
        modelId: model.id,
        provider: model.provider,
        upstreamStatus: error.status,
        error: error.message
      });
      const message = error.name === 'TtsUpstreamError' ? error.message : 'Text-to-speech failed';
      throw new ServiceError('UPSTREAM_ERROR', message, {
        details: { remediation: message },
        cause: error
      });
    }
    if (bytes === 0) {
      throw new ServiceError('NO_AUDIO', 'No audio was returned', {
        details: { remediation: 'The text-to-speech model answered without any audio.' }
      });
    }
    const seconds = bytes / 2 / provider.sampleRate;
    return res.json({
      message: 'Model test successful',
      messageKey: 'testSuccessful',
      response: `Generated ${seconds.toFixed(1)} s of speech (voice: ${cfg.voice})`,
      model: safeModel
    });
  }

  /**
   * Start a session with a transcription model's upstream (or, for a batch
   * model, transcribe a second of silence). Same response shape as a chat
   * model test; `response` says what the endpoint did.
   */
  async function testTranscription(model, res) {
    const safeModel = { ...model };
    delete safeModel.apiKey;
    const result = await testTranscriptionModel(model);
    if (!result.ok) {
      logger.error('Transcription model test failed', {
        component: 'ModelsRoutes',
        modelId: model.id,
        provider: model.provider,
        error: result.message
      });
      throw new ServiceError('UPSTREAM_ERROR', result.message, {
        details: { remediation: result.message }
      });
    }
    return res.json({
      message: 'Model test successful',
      messageKey: 'testSuccessful',
      response: result.message,
      model: safeModel
    });
  }

  /**
   * GET /api/admin/models/:modelId/tts/voices — the voices a TTS model can
   * use: the provider's presets and the account's custom voices.
   */
  app.get(buildServerPath('/api/admin/models/:modelId/tts/voices'), adminAuth, async (req, res) => {
    const resolved = resolveVoicesModel(req);
    try {
      const voices = await resolved.provider.listVoices(resolved.cfg);
      return res.json({ items: voices });
    } catch (error) {
      throw voicesError(error, 'list voices');
    }
  });

  /**
   * POST /api/admin/models/:modelId/tts/voices — create a custom voice from
   * one recording of the speaker: `{ name, audio (base64), filename?,
   * languages?, gender? }`. Answers `201` with the new voice; its `id` goes into the
   * model's voice settings.
   */
  app.post(
    buildServerPath('/api/admin/models/:modelId/tts/voices'),
    adminAuth,
    async (req, res) => {
      const resolved = resolveVoicesModel(req);
      const { name, audio, filename, languages, gender } = req.body || {};

      const voiceName = typeof name === 'string' ? name.trim() : '';
      if (!voiceName || voiceName.length > 100) {
        throw new ServiceError('BAD_REQUEST', 'name is required (at most 100 characters)');
      }
      if (typeof audio !== 'string' || !audio) {
        throw new ServiceError('INVALID_AUDIO', 'audio is required');
      }
      const sample = Buffer.from(audio, 'base64');
      if (!sample.length) {
        throw new ServiceError('INVALID_AUDIO', 'audio is not valid base64');
      }
      if (sample.length > MAX_VOICE_SAMPLE_BYTES) {
        throw new ServiceError('PAYLOAD_TOO_LARGE', 'The voice sample is too large');
      }
      const safeName =
        typeof filename === 'string' ? filename.replace(/[^\w.-]/g, '_').slice(-100) : '';
      const extension = safeName.includes('.') ? safeName.split('.').pop().toLowerCase() : 'wav';
      if (!VOICE_SAMPLE_EXTENSIONS.has(extension)) {
        throw new ServiceError('INVALID_AUDIO', 'Unsupported audio file type');
      }
      const voiceLanguages = Array.isArray(languages)
        ? [...new Set(languages.filter(l => TTS_LANGUAGES.includes(l)))]
        : [];
      const voiceGender = gender === 'male' || gender === 'female' ? gender : undefined;

      try {
        const voice = await resolved.provider.createVoice(resolved.cfg, {
          name: voiceName,
          audio: sample,
          filename: safeName.includes('.') ? safeName : `sample.${extension}`,
          languages: voiceLanguages,
          gender: voiceGender
        });
        await logAudit({
          req,
          action: 'create',
          resource: 'tts-voice',
          resourceId: voice.id,
          summary: `Created text-to-speech voice "${voiceName}" for model ${resolved.model.id}`
        });
        return sendCreated(
          res,
          `/api/admin/models/${segment(resolved.model.id)}/tts/voices/${segment(voice.id)}`,
          voice
        );
      } catch (error) {
        throw voicesError(error, 'create the voice');
      }
    }
  );

  /**
   * GET /api/admin/models/:modelId/tts/voices/:voiceId — one voice of the model
   * (the `Location` a create answers with).
   */
  app.get(
    buildServerPath('/api/admin/models/:modelId/tts/voices/:voiceId'),
    adminAuth,
    async (req, res) => {
      const resolved = resolveVoicesModel(req);
      const { voiceId } = req.params;
      if (!/^[\w-]{1,100}$/.test(voiceId)) {
        throw new ServiceError('BAD_REQUEST', 'Invalid voice id');
      }
      let voices;
      try {
        voices = await resolved.provider.listVoices(resolved.cfg);
      } catch (error) {
        throw voicesError(error, 'read voice');
      }
      const voice = voices.find(candidate => candidate.id === voiceId);
      if (!voice) throw new ServiceError('NOT_FOUND', 'Voice not found');
      return res.json(voice);
    }
  );

  /** DELETE /api/admin/models/:modelId/tts/voices/:voiceId — delete a custom voice. */
  app.delete(
    buildServerPath('/api/admin/models/:modelId/tts/voices/:voiceId'),
    adminAuth,
    async (req, res) => {
      const resolved = resolveVoicesModel(req);
      const { voiceId } = req.params;
      if (!/^[\w-]{1,100}$/.test(voiceId)) {
        throw new ServiceError('BAD_REQUEST', 'Invalid voice id');
      }
      try {
        await resolved.provider.deleteVoice(resolved.cfg, voiceId);
        await logAudit({
          req,
          action: 'delete',
          resource: 'tts-voice',
          resourceId: voiceId,
          summary: `Deleted text-to-speech voice ${voiceId} of model ${resolved.model.id}`
        });
        return res.status(204).end();
      } catch (error) {
        throw voicesError(error, 'delete the voice');
      }
    }
  );

  app.post(buildServerPath('/api/admin/models/:modelId/_test'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      assertValidId(modelId, 'model');

      const { data: models } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        throw new ServiceError('NOT_FOUND', 'Model not found');
      }

      // A text-to-speech model is tested by speaking a short sentence.
      if (isTtsModel(model)) {
        return testTtsModel(model, res);
      }
      // A transcription model is tested by starting a session upstream.
      if (isTranscriptionModel(model)) {
        return testTranscription(model, res);
      }

      try {
        const result = await llmClient.complete({
          model,
          messages: [{ role: 'user', content: MODEL_TEST_MESSAGE }],
          retries: 0,
          timeoutMs: MODEL_TEST_TIMEOUT_MS,
          telemetry: { kind: 'diagnostic', purpose: 'model-test', user: req.user }
        });
        // Never echo stored credentials back to the browser (mirrors GET /admin/models).
        const safeModel = { ...model };
        delete safeModel.apiKey;
        res.json({
          message: 'Model test successful',
          messageKey: 'testSuccessful',
          response: result.content,
          model: safeModel
        });
      } catch (testError) {
        if (!isLLMError(testError)) {
          throw testError;
        }
        logger.error('Model test failed', {
          component: 'ModelsRoutes',
          modelId: model.id,
          provider: model.provider,
          code: testError.code,
          providerCode: testError.providerCode,
          upstreamStatus: testError.status,
          error: testError.message
        });
        const { userMessage, errorMessage, messageKey, upstreamStatus, host, errorCode } =
          describeLlmFailure(testError, {
            url: model.url,
            keyless: inspectModelApiKey(model, { quiet: true }).state === 'keyless'
          });
        const mappedStatus = llmErrorToHttpStatus(testError);
        const httpStatus = mappedStatus >= 400 ? mappedStatus : 502;
        throw new ServiceError(
          isApiErrorCode(testError.code) ? testError.code : 'UPSTREAM_ERROR',
          userMessage,
          {
            status: httpStatus,
            // The facts (status, host, code) let the admin tell a wrong URL from a
            // rejected key or a broken service; none of them is a secret.
            details: {
              remediation: errorMessage,
              messageKey,
              ...(upstreamStatus === null ? {} : { upstreamStatus }),
              ...(host === null ? {} : { host }),
              ...(errorCode === null ? {} : { errorCode })
            },
            cause: testError
          }
        );
      }
    } catch (error) {
      logger.error('Error testing model', { component: 'ModelsRoutes', error });
      throw error;
    }
  });
}
