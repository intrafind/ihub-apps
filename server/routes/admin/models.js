import { getLocalizedContent } from '../../../shared/localize.js';
import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, validateIdsForPath } from '../../utils/pathSecurity.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import logger from '../../utils/logger.js';
import { removeMarketplaceInstallation } from '../../utils/installationCleanup.js';
import {
  sendInternalError,
  sendNotFound,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import llmClient, { isLLMError, LLM_ERROR_CODES } from '../../services/loop/LLMClient.js';
import { getTtsProvider, isTtsModel } from '../../tts/index.js';
import { isTranscriptionModel } from '../../transcription/index.js';
import { testTranscriptionModel } from '../../websocket/realtimeTranscription.js';
import { TTS_LANGUAGES } from '../../tts/language.js';
import { llmErrorToHttpStatus, isMissingApiKeyError } from '../../services/loop/llmHttpErrors.js';
import {
  discoverModels,
  comparableUrl,
  ModelDiscoveryError
} from '../../services/ModelEndpointDiscovery.js';
import {
  BUILT_IN_LLM_PROVIDERS,
  getProviderApiType,
  resolveProviderApiKey
} from '../../services/llmProviders.js';

/** Largest voice sample accepted (Mistral needs seconds, not minutes, of audio). */
const MAX_VOICE_SAMPLE_BYTES = 10 * 1024 * 1024;
/** Audio file types a voice sample may have. */
const VOICE_SAMPLE_EXTENSIONS = ['wav', 'mp3', 'm4a', 'ogg', 'oga', 'opus', 'flac', 'webm'];

/**
 * The TTS model and its provider for a voices request, or an error response.
 * Disabled models are allowed, so voices can be set up before enabling.
 */
function resolveVoicesModel(req, res) {
  const { modelId } = req.params;
  if (!validateIdForPath(modelId, 'model', res)) return null;
  const { data: models } = configCache.getModels(true);
  const model = models.find(m => m.id === modelId);
  if (!model) {
    sendNotFound(res, 'Model');
    return null;
  }
  if (!isTtsModel(model)) {
    res.status(400).json({ error: 'Not a text-to-speech model', code: 'not-tts-model' });
    return null;
  }
  const provider = getTtsProvider(model.provider);
  if (!provider?.listVoices) {
    res.status(501).json({
      error: `Provider "${model.provider}" does not manage voices`,
      code: 'voices-unsupported'
    });
    return null;
  }
  return { model, provider, cfg: provider.resolveUpstream(model) };
}

/** Upstream failures carry a safe message; anything else stays in the log. */
function sendVoicesError(res, error, action) {
  logger.error(`Text-to-speech voices: ${action} failed`, {
    component: 'ModelsRoutes',
    upstreamStatus: error.status,
    error: error.message
  });
  const message = error.name === 'TtsUpstreamError' ? error.message : `Could not ${action}`;
  return res.status(502).json({ error: message, code: 'upstream-error' });
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
function modelPath(modelId) {
  return configStore.resolveIdToPath('models', modelId);
}

/** Prompt sent by the admin "test model" diagnostic. */
const MODEL_TEST_MESSAGE = 'Hello, can you respond with a simple "Test successful" message?';

/** Hard cap for one model test call (interactive admin request). */
const MODEL_TEST_TIMEOUT_MS = 60000;

/**
 * Socket-level failure codes (undici / Node `net`) that deserve a dedicated
 * explanation in the admin UI. Checked before the generic code mapping.
 */
const MODEL_TEST_NETWORK_CAUSES = Object.freeze({
  UND_ERR_CONNECT_TIMEOUT: {
    userMessage: 'Connection timeout',
    messageKey: 'connectionTimeout',
    errorMessage:
      'The model service did not respond within the timeout period. Please check if the model URL is correct and the service is running.'
  },
  ECONNREFUSED: {
    userMessage: 'Connection refused',
    messageKey: 'connectionRefused',
    errorMessage:
      'Unable to connect to the model service. Please verify the URL and ensure the service is running.'
  },
  ENOTFOUND: {
    userMessage: 'Service not found',
    messageKey: 'serviceNotFound',
    errorMessage:
      'The model service hostname could not be resolved. Please check the URL configuration.'
  }
});

/**
 * Translate an `LLMError` raised by a model connectivity test into the
 * strings the admin UI shows: a short `userMessage` headline (English,
 * used as a fallback and in logs), a longer `errorMessage` with remediation
 * hints, and a `messageKey` — a stable identifier the client maps to a
 * translated headline (see shared/i18n/*.json `admin.models.testResults.messages`).
 *
 * Keys off `err.code` (and the underlying socket error code for network
 * failures) — never off message substrings, which differ per provider and
 * language.
 *
 * @param {import('../../services/loop/contracts/errors.js').LLMError} err
 * @returns {{ userMessage: string, errorMessage: string, messageKey: string }}
 */
function describeModelTestFailure(err) {
  // `fetch failed` wraps the socket error one level deeper (err.cause.cause);
  // LLMClient also surfaces that code as providerCode for network failures.
  const socketCode = String(err.providerCode || err.cause?.code || err.cause?.cause?.code || '');
  if (MODEL_TEST_NETWORK_CAUSES[socketCode]) {
    return MODEL_TEST_NETWORK_CAUSES[socketCode];
  }

  const fallback = {
    userMessage: 'Model test failed',
    messageKey: 'testFailed',
    errorMessage: err.message || 'Unknown error occurred'
  };

  switch (err.code) {
    case LLM_ERROR_CODES.NETWORK: {
      const detail =
        typeof err.details === 'string' && err.details
          ? err.details
          : err.cause?.message || err.message;
      return {
        userMessage: 'Network error',
        messageKey: 'networkError',
        errorMessage: `Network connection failed: ${detail}`
      };
    }
    case LLM_ERROR_CODES.TIMEOUT:
      return {
        userMessage: 'Request timeout',
        messageKey: 'requestTimeout',
        errorMessage:
          'The model service took too long to respond. Please try again or check the service status.'
      };
    case LLM_ERROR_CODES.AUTH_FAILED:
      if (isMissingApiKeyError(err)) {
        return {
          userMessage: 'API key not configured',
          messageKey: 'apiKeyNotConfigured',
          errorMessage: err.message
        };
      }
      if (err.status === 403) {
        return {
          userMessage: 'Access denied',
          messageKey: 'accessDenied',
          errorMessage: 'Access denied by the model service. Please check your API key permissions.'
        };
      }
      return {
        userMessage: 'Authentication failed',
        messageKey: 'authenticationFailed',
        errorMessage:
          'Invalid API key or authentication credentials. Please check your model configuration.'
      };
    case LLM_ERROR_CODES.MODEL_NOT_FOUND:
      return {
        userMessage: 'Model not found',
        messageKey: 'modelNotFound',
        errorMessage:
          'The specified model was not found on the service. Please check the model ID configuration.'
      };
    case LLM_ERROR_CODES.RATE_LIMITED:
      return {
        userMessage: 'Rate limit exceeded',
        messageKey: 'rateLimitExceeded',
        errorMessage: 'Too many requests to the model service. Please try again later.'
      };
    case LLM_ERROR_CODES.PROVIDER_ERROR:
      if (typeof err.status === 'number' && err.status >= 500) {
        return {
          userMessage: 'Server error',
          messageKey: 'serverError',
          errorMessage: 'The model service encountered an internal error. Please try again later.'
        };
      }
      return fallback;
    default:
      return fallback;
  }
}

export { describeModelTestFailure };

/**
 * Bring a model's link to a provider entry in line with that entry, in place:
 * the model's `provider` becomes the entry's API type, and a link to a built-in
 * entry (`providerId: "openai"`) is dropped, since the model reaches it through
 * its API type anyway. A link to a custom entry is always kept. A model
 * therefore cannot claim one API type while its provider declares another.
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
  const apiType = getProviderApiType(providers.find(p => p.id === model.providerId));
  if (!apiType) {
    return `Provider "${model.providerId}" does not exist or is not an LLM provider`;
  }
  model.provider = apiType;
  if (BUILT_IN_LLM_PROVIDERS.includes(model.providerId)) {
    delete model.providerId;
  }
  return null;
}

export { applyProviderLink };

/**
 * Only a chat model can be the default (see `modelsLoader.js`): a TTS or
 * transcription model never takes the flag, nor the flag from the chat model
 * it would replace.
 */
const isChatModel = model => (model.modelType || 'chat') === 'chat';

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
    try {
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

      res.setHeader('ETag', modelsEtag);
      res.json(maskedModels);
    } catch (error) {
      return sendInternalError(res, error, 'fetch all models');
    }
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
   *                 enum: [openai, openai-responses, mistral, local, anthropic, google]
   *                 default: openai
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
    const { url, providerId, apiType = 'openai', apiKey } = req.body || {};
    if (url !== undefined && url !== null && typeof url !== 'string') {
      return sendBadRequest(res, 'Invalid URL');
    }
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') {
      return sendBadRequest(res, 'Invalid API key');
    }

    let discoveryUrl = (url || '').trim();
    let discoveryApiType = apiType;
    let discoveryKey = (apiKey || '').trim();

    try {
      if (providerId !== undefined && providerId !== null && providerId !== '') {
        if (!validateIdForPath(providerId, 'provider', res)) {
          return;
        }
        const { data: providers = [] } = configCache.getProviders(true);
        const providerEntry = providers.find(p => p.id === providerId);
        if (!providerEntry) {
          return sendNotFound(res, 'Provider');
        }
        discoveryApiType = getProviderApiType(providerEntry);
        if (!discoveryApiType) {
          return sendBadRequest(res, `Provider "${providerId}" is not an LLM provider`);
        }
        if (!discoveryUrl) discoveryUrl = providerEntry.baseUrl || '';
        if (!discoveryKey) discoveryKey = resolveProviderApiKey(providerEntry) || '';
      } else if (typeof apiType !== 'string') {
        return sendBadRequest(res, 'Invalid API type');
      }

      if (!discoveryUrl) {
        return sendBadRequest(res, 'URL is required');
      }

      const result = await discoverModels({
        url: discoveryUrl,
        provider: discoveryApiType,
        apiKey: discoveryKey
      });

      // Flag listed models an existing config already points at (same remote
      // model id on the same endpoint), so the admin does not import twice.
      const { data: configured = [] } = configCache.getModels(true);
      const existing = new Map();
      for (const model of configured) {
        existing.set(`${model.modelId}\n${comparableUrl(model.url)}`, model.id);
      }
      res.json({
        apiType: result.provider,
        modelsUrl: result.modelsUrl,
        baseUrl: result.baseUrl,
        models: result.models.map(model => ({
          ...model,
          existingModelId: existing.get(`${model.id}\n${comparableUrl(model.url)}`) || null
        }))
      });
    } catch (error) {
      if (error instanceof ModelDiscoveryError) {
        return res.status(error.status).json({
          error: error.message,
          details: error.details,
          messageKey: error.messageKey,
          upstreamStatus: error.upstreamStatus
        });
      }
      return sendInternalError(res, error, 'discover models');
    }
  });

  app.get(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const { data: models, etag: modelsEtag } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return sendNotFound(res, 'Model');
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

      res.setHeader('ETag', modelsEtag);
      res.json(maskedModel);
    } catch (error) {
      return sendInternalError(res, error, 'fetch model');
    }
  });

  app.put(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;
      const updatedModel = req.body;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      if (
        !updatedModel.id ||
        !getLocalizedContent(updatedModel.name, defaultLang) ||
        !getLocalizedContent(updatedModel.description, defaultLang) ||
        !updatedModel.provider
      ) {
        return sendBadRequest(res, 'Missing required fields');
      }
      if (updatedModel.id !== modelId) {
        return sendBadRequest(res, 'Model ID cannot be changed');
      }
      const providerLinkError = applyProviderLink(updatedModel);
      if (providerLinkError) {
        return sendBadRequest(res, providerLinkError);
      }

      // Handle API key encryption
      if (updatedModel.apiKey) {
        // Check if this is a new key or unchanged masked value
        if (updatedModel.apiKey !== '••••••••') {
          // New key provided - encrypt it
          try {
            updatedModel.apiKey = tokenStorageService.encryptString(updatedModel.apiKey);
          } catch (error) {
            return sendInternalError(res, error, 'encrypt API key');
          }
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

      if (!isChatModel(updatedModel)) updatedModel.default = false;
      if (updatedModel.default === true) {
        const modelsResponse = configCache.getModels(true);
        const allModels = modelsResponse.data || modelsResponse;
        for (const model of allModels) {
          if (model.id !== modelId && model.default === true) {
            model.default = false;
            await configStore.writeJson(await modelPath(model.id), model);
          }
        }
      }
      // Capture old model state before writing
      const { data: currentModels } = configCache.getModels(true);
      const oldModel = currentModels.find(m => m.id === modelId);

      await configStore.writeJson(await modelPath(modelId), updatedModel);
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
      res.json({ message: 'Model updated successfully', model: updatedModel });
    } catch (error) {
      return sendInternalError(res, error, 'update model');
    }
  });

  app.post(buildServerPath('/api/admin/models'), adminAuth, async (req, res) => {
    try {
      const newModel = req.body;
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      if (
        !newModel.id ||
        !getLocalizedContent(newModel.name, defaultLang) ||
        !getLocalizedContent(newModel.description, defaultLang) ||
        !newModel.provider
      ) {
        return sendBadRequest(res, 'Missing required fields');
      }

      // Validate newModel.id for security
      if (!validateIdForPath(newModel.id, 'model', res)) {
        return;
      }
      const providerLinkError = applyProviderLink(newModel);
      if (providerLinkError) {
        return sendBadRequest(res, providerLinkError);
      }

      // Handle API key encryption
      if (newModel.apiKey && newModel.apiKey !== '••••••••') {
        // New key provided - encrypt it
        try {
          newModel.apiKey = tokenStorageService.encryptString(newModel.apiKey);
        } catch (error) {
          return sendInternalError(res, error, 'encrypt API key');
        }
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
        return sendErrorResponse(res, 409, 'Model with this ID already exists');
      }
      if (!isChatModel(newModel)) newModel.default = false;
      if (newModel.default === true) {
        const modelsResponse = configCache.getModels(true);
        const allModels = modelsResponse.data || modelsResponse;
        for (const model of allModels) {
          if (model.default === true) {
            model.default = false;
            await configStore.writeJson(await modelPath(model.id), model);
          }
        }
      }
      await configStore.writeJson(newModelPath, newModel);
      await configCache.refreshModelsCache();
      await logAudit({
        req,
        action: 'create',
        resource: 'model',
        resourceId: newModel.id,
        summary: `Created model ${newModel.id}`
      });
      res.json({ message: 'Model created successfully', model: newModel });
    } catch (error) {
      return sendInternalError(res, error, 'create model');
    }
  });

  app.post(buildServerPath('/api/admin/models/:modelId/toggle'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return sendNotFound(res, 'Model');
      }
      const newEnabledState = !model.enabled;
      model.enabled = newEnabledState;
      if (!newEnabledState && model.default === true) {
        const enabledModels = models.filter(
          m => m.id !== modelId && m.enabled === true && isChatModel(m)
        );
        if (enabledModels.length > 0) {
          enabledModels[0].default = true;
          await configStore.writeJson(await modelPath(enabledModels[0].id), enabledModels[0]);
        }
        model.default = false;
      }
      await configStore.writeJson(await modelPath(modelId), model);
      await configCache.refreshModelsCache();
      await logAudit({
        req,
        action: 'toggle',
        resource: 'model',
        resourceId: modelId,
        summary: `${newEnabledState ? 'Enabled' : 'Disabled'} model ${modelId}`
      });
      res.json({
        message: `Model ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
        model: model,
        enabled: newEnabledState
      });
    } catch (error) {
      return sendInternalError(res, error, 'toggle model');
    }
  });

  app.post(buildServerPath('/api/admin/models/:modelIds/_toggle'), adminAuth, async (req, res) => {
    try {
      const { modelIds } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return sendBadRequest(res, 'Missing enabled flag');
      }

      // Validate modelIds for security
      const ids = validateIdsForPath(modelIds, 'model', res);
      if (!ids) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const resolvedIds = ids.includes('*') ? models.map(m => m.id) : ids;

      for (const id of resolvedIds) {
        const model = models.find(m => m.id === id);
        if (!model) continue;
        model.enabled = enabled;
        if (!enabled) {
          model.default = false;
        }
        await configStore.writeJson(await modelPath(id), model);
      }

      // ensure at least one enabled model has default=true
      const enabledModels = models.filter(m => m.enabled && isChatModel(m));
      if (enabledModels.length > 0 && !enabledModels.some(m => m.default)) {
        enabledModels[0].default = true;
        await configStore.writeJson(await modelPath(enabledModels[0].id), enabledModels[0]);
      }

      await configCache.refreshModelsCache();
      await logAudit({
        req,
        action: 'toggle',
        resource: 'model',
        resourceId: resolvedIds.join(','),
        summary: `Batch ${enabled ? 'enabled' : 'disabled'} ${resolvedIds.length} models`
      });
      res.json({
        message: `Models ${enabled ? 'enabled' : 'disabled'} successfully`,
        enabled,
        ids: resolvedIds
      });
    } catch (error) {
      return sendInternalError(res, error, 'toggle models');
    }
  });

  app.delete(buildServerPath('/api/admin/models/:modelId'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return sendNotFound(res, 'Model');
      }
      if (model.default === true) {
        const otherModels = models.filter(
          m => m.id !== modelId && m.enabled === true && isChatModel(m)
        );
        if (otherModels.length > 0) {
          otherModels[0].default = true;
          await configStore.writeJson(await modelPath(otherModels[0].id), otherModels[0]);
        }
      }
      if (!(await configStore.remove(await modelPath(modelId)))) {
        return sendNotFound(res, 'Model file');
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
      res.json({ message: 'Model deleted successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'delete model');
    }
  });

  /**
   * POST /api/admin/models/:modelId/test
   *
   * Connectivity / credential diagnostic for one configured model. Disabled
   * models are included so an admin can verify a model before enabling it.
   * The call goes through `LLMClient` and is recorded in the run ledger as a
   * `diagnostic` run. Failures answer with a non-2xx status derived from the
   * `LLMError` code and a body of `{ error, details, code }` — `error` is the
   * short headline, `details` the remediation text shown by the admin UI.
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
      return res.status(400).json({
        error: `Unsupported text-to-speech provider: ${model.provider}`,
        code: 'unsupported-provider'
      });
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
      return res.status(502).json({ error: message, details: message, code: 'upstream-error' });
    }
    if (bytes === 0) {
      return res.status(502).json({
        error: 'No audio was returned',
        details: 'The text-to-speech model answered without any audio.',
        code: 'no-audio'
      });
    }
    const seconds = bytes / 2 / provider.sampleRate;
    return res.json({
      success: true,
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
      return res
        .status(502)
        .json({ error: result.message, details: result.message, code: 'upstream-error' });
    }
    return res.json({
      success: true,
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
    const resolved = resolveVoicesModel(req, res);
    if (!resolved) return undefined;
    try {
      const voices = await resolved.provider.listVoices(resolved.cfg);
      return res.json({ voices });
    } catch (error) {
      return sendVoicesError(res, error, 'list voices');
    }
  });

  /**
   * POST /api/admin/models/:modelId/tts/voices — create a custom voice from
   * one recording of the speaker: `{ name, audio (base64), filename?,
   * languages?, gender? }`. Answers with the new voice; its `id` goes into the
   * model's voice settings.
   */
  app.post(
    buildServerPath('/api/admin/models/:modelId/tts/voices'),
    adminAuth,
    async (req, res) => {
      const resolved = resolveVoicesModel(req, res);
      if (!resolved) return undefined;
      const { name, audio, filename, languages, gender } = req.body || {};

      const voiceName = typeof name === 'string' ? name.trim() : '';
      if (!voiceName || voiceName.length > 100) {
        return res
          .status(400)
          .json({ error: 'name is required (at most 100 characters)', code: 'invalid-name' });
      }
      if (typeof audio !== 'string' || !audio) {
        return res.status(400).json({ error: 'audio is required', code: 'invalid-audio' });
      }
      const sample = Buffer.from(audio, 'base64');
      if (!sample.length) {
        return res.status(400).json({ error: 'audio is not valid base64', code: 'invalid-audio' });
      }
      if (sample.length > MAX_VOICE_SAMPLE_BYTES) {
        return res
          .status(413)
          .json({ error: 'The voice sample is too large', code: 'audio-too-large' });
      }
      const safeName =
        typeof filename === 'string' ? filename.replace(/[^\w.-]/g, '_').slice(-100) : '';
      const extension = safeName.includes('.') ? safeName.split('.').pop().toLowerCase() : 'wav';
      if (!VOICE_SAMPLE_EXTENSIONS.includes(extension)) {
        return res
          .status(400)
          .json({ error: 'Unsupported audio file type', code: 'invalid-audio' });
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
        return res.json({ voice });
      } catch (error) {
        return sendVoicesError(res, error, 'create the voice');
      }
    }
  );

  /** DELETE /api/admin/models/:modelId/tts/voices/:voiceId — delete a custom voice. */
  app.delete(
    buildServerPath('/api/admin/models/:modelId/tts/voices/:voiceId'),
    adminAuth,
    async (req, res) => {
      const resolved = resolveVoicesModel(req, res);
      if (!resolved) return undefined;
      const { voiceId } = req.params;
      if (!/^[\w-]{1,100}$/.test(voiceId)) {
        return res.status(400).json({ error: 'Invalid voice id', code: 'invalid-voice' });
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
        return res.json({ deleted: voiceId });
      } catch (error) {
        return sendVoicesError(res, error, 'delete the voice');
      }
    }
  );

  app.post(buildServerPath('/api/admin/models/:modelId/test'), adminAuth, async (req, res) => {
    try {
      const { modelId } = req.params;

      // Validate modelId for security
      if (!validateIdForPath(modelId, 'model', res)) {
        return;
      }

      const { data: models } = configCache.getModels(true);
      const model = models.find(m => m.id === modelId);
      if (!model) {
        return sendNotFound(res, 'Model');
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
          success: true,
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
        const { userMessage, errorMessage, messageKey } = describeModelTestFailure(testError);
        const mappedStatus = llmErrorToHttpStatus(testError);
        const httpStatus = mappedStatus >= 400 ? mappedStatus : 502;
        res
          .status(httpStatus)
          .json({ error: userMessage, details: errorMessage, code: testError.code, messageKey });
      }
    } catch (error) {
      logger.error('Error testing model', { component: 'ModelsRoutes', error });
      sendInternalError(res, error, 'test model');
    }
  });
}
