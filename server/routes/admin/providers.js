import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, sanitizeLanguageCode } from '../../utils/pathSecurity.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import { getProviderConfigSchema } from '../../adapters/index.js';
import { sendInternalError, sendNotFound, sendBadRequest } from '../../utils/responseHelpers.js';
import webSearchService from '../../services/WebSearchService.js';
import {
  diagnoseSearchError,
  diagnoseSearchSuccess,
  providerLabel
} from '../../services/search/searchDiagnostics.js';
import { getProxyConfig, redactUrlSecrets } from '../../utils/httpConfig.js';
import config from '../../config.js';
import logger from '../../utils/logger.js';
import {
  BUILT_IN_LLM_PROVIDERS,
  CUSTOM_PROVIDER_API_TYPES,
  getLinkedModels,
  getProviderApiType,
  isCustomLlmProvider
} from '../../services/llmProviders.js';

/** The provider configuration, as a path relative to `contents/`. */
const PROVIDERS_FILE = 'config/providers.json';

/** Categories a provider can be created in. */
const PROVIDER_CATEGORIES = ['llm', 'websearch', 'custom'];

/**
 * Validate and tidy the editable fields of a provider entry, in place.
 *
 * `name` and `description` are plain strings (V141 converted the per-language
 * objects). A custom LLM provider needs the `apiType` its endpoint speaks and
 * may carry a `baseUrl` used to list its models; a built-in LLM provider's API
 * type is its id, so an `apiType` on it is dropped. Other categories have
 * neither field.
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
    return null;
  }

  if (BUILT_IN_LLM_PROVIDERS.includes(provider.id)) {
    delete provider.apiType;
  } else if (!CUSTOM_PROVIDER_API_TYPES.includes(provider.apiType)) {
    return `API type must be one of: ${CUSTOM_PROVIDER_API_TYPES.join(', ')}`;
  }

  if (provider.baseUrl === undefined || provider.baseUrl === null || provider.baseUrl === '') {
    delete provider.baseUrl;
  } else if (
    typeof provider.baseUrl !== 'string' ||
    !/^https?:\/\/[^\s]+$/i.test(provider.baseUrl.trim())
  ) {
    return 'Base URL must be an http:// or https:// URL';
  } else {
    provider.baseUrl = provider.baseUrl.trim().replace(/\/+$/, '');
  }
  return null;
}

/**
 * Point every model linked to a custom LLM provider at the provider's API
 * type, so changing it on the provider changes it for all of its models.
 *
 * @param {Object} provider - The saved provider entry
 * @returns {Promise<string[]>} Ids of the models rewritten
 */
async function syncLinkedModelsApiType(provider) {
  if (!isCustomLlmProvider(provider)) return [];
  const apiType = getProviderApiType(provider);
  const { data: models = [] } = configCache.getModels(true);
  const updated = [];
  for (const model of getLinkedModels(provider.id, models)) {
    if (model.provider === apiType) continue;
    const modelPath = await configStore.resolveIdToPath('models', model.id);
    if (!modelPath) continue;
    await configStore.writeJson(modelPath, { ...model, provider: apiType });
    updated.push(model.id);
  }
  if (updated.length > 0) {
    await configCache.refreshModelsCache();
  }
  return updated;
}

/**
 * Query used when the admin does not supply one. Deliberately bland and
 * non-topical: the test is about whether the provider answers this server at
 * all, so the query should never be the reason a result set is empty.
 */
const DEFAULT_TEST_QUERY = 'open source software';

/** Upper bound on an admin-supplied test query. */
const MAX_TEST_QUERY_LENGTH = 100;

/** Results echoed back to the UI, as proof the response was real. */
const SAMPLE_RESULT_COUNT = 3;

/** Characters kept per echoed field, so one test cannot return a huge payload. */
const SAMPLE_FIELD_LENGTH = 300;

/** Ceiling on one test, so a hung provider cannot hold the admin request open. */
const TEST_TIMEOUT_MS = 20000;

/**
 * Trim an untrusted string from a search result to a bounded length.
 * @param {unknown} value
 * @returns {string}
 */
function truncate(value) {
  return typeof value === 'string' ? value.slice(0, SAMPLE_FIELD_LENGTH) : '';
}

/**
 * Reject a search that takes longer than the admin UI is willing to wait.
 * The underlying request is not cancelled — it is left to finish and be
 * discarded, which is acceptable for a diagnostic.
 * @param {Promise} promise
 * @param {number} ms
 * @returns {Promise}
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Search did not answer within ${ms / 1000}s`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
    try {
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

      res.setHeader('ETag', providersEtag);
      res.json(maskedProviders);
    } catch (error) {
      return sendInternalError(res, error, 'fetch providers');
    }
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
      try {
        const { providerId } = req.params;
        if (!validateIdForPath(providerId, 'provider', res)) return;
        const schema = await getProviderConfigSchema(providerId);
        res.json(schema || { fields: [] });
      } catch (error) {
        return sendInternalError(res, error, 'fetch provider schema');
      }
    }
  );

  app.get(buildServerPath('/api/admin/providers/:providerId'), adminAuth, async (req, res) => {
    try {
      const { providerId } = req.params;

      // Validate providerId for security
      if (!validateIdForPath(providerId, 'provider', res)) {
        return;
      }

      const { data: providers, etag: providersEtag } = configCache.getProviders(true);
      const provider = providers.find(p => p.id === providerId);
      if (!provider) {
        return sendNotFound(res, 'Provider');
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

      res.setHeader('ETag', providersEtag);
      res.json(maskedProvider);
    } catch (error) {
      return sendInternalError(res, error, 'fetch provider');
    }
  });

  app.put(buildServerPath('/api/admin/providers/:providerId'), adminAuth, async (req, res) => {
    try {
      const { providerId } = req.params;
      const updatedProvider = req.body;

      // Validate providerId for security
      if (!validateIdForPath(providerId, 'provider', res)) {
        return;
      }

      if (updatedProvider.id !== providerId) {
        return sendBadRequest(res, 'Provider ID cannot be changed');
      }

      // Define paths once at the top
      // Handle API key encryption
      if (updatedProvider.apiKey) {
        // Check if this is a new key or unchanged masked value
        if (updatedProvider.apiKey !== '••••••••') {
          // New key provided - encrypt it
          try {
            updatedProvider.apiKey = tokenStorageService.encryptString(updatedProvider.apiKey);
          } catch (error) {
            return sendInternalError(res, error, 'encrypt API key');
          }
        } else {
          // Masked value - need to preserve existing key
          // CRITICAL FIX: Read the stored file, not the cache, to ensure we have
          // the apiKey field. The cache might not have it due to TTL expiration
          // or race conditions.
          const stored = await configStore.readJson(PROVIDERS_FILE);
          const existingProvider = Array.isArray(stored?.providers)
            ? stored.providers.find(p => p.id === providerId)
            : undefined;
          if (existingProvider?.apiKey) {
            // Preserve the existing encrypted API key
            updatedProvider.apiKey = existingProvider.apiKey;
          } else {
            // Nothing stored to preserve, drop the masked placeholder
            delete updatedProvider.apiKey;
          }
        }
      }

      // Remove client-side helper fields
      delete updatedProvider.apiKeySet;
      delete updatedProvider.apiKeyMasked;

      // Load current providers and create a deep copy to avoid cache mutation
      const { data: cachedProviders } = configCache.getProviders(true);

      // Create a deep copy of the providers array to avoid mutating the cache
      const providers = cachedProviders.map(p => ({ ...p }));

      // Find and update the provider
      const index = providers.findIndex(p => p.id === providerId);
      if (index === -1) {
        return sendNotFound(res, 'Provider');
      }

      // The category decides which fields an entry has; it is fixed at creation.
      if (providers[index].category !== undefined) {
        updatedProvider.category = providers[index].category;
      } else {
        delete updatedProvider.category;
      }
      const validationError = normalizeProviderFields(updatedProvider);
      if (validationError) {
        return sendBadRequest(res, validationError);
      }

      providers[index] = updatedProvider;

      // Save updated providers
      await configStore.writeJson(PROVIDERS_FILE, { providers });
      await configCache.refreshProvidersCache();
      const updatedModels = await syncLinkedModelsApiType(updatedProvider);

      res.json({
        message: 'Provider updated successfully',
        provider: updatedProvider,
        updatedModels
      });
    } catch (error) {
      return sendInternalError(res, error, 'update provider');
    }
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
    try {
      const newProvider = req.body;

      // Validate required fields
      if (!newProvider.id) {
        return sendBadRequest(res, 'Missing required field: id');
      }

      // Validate providerId for security
      if (!validateIdForPath(newProvider.id, 'provider', res)) {
        return;
      }

      if (!newProvider.category) {
        newProvider.category = 'custom';
      }
      if (!PROVIDER_CATEGORIES.includes(newProvider.category)) {
        return sendBadRequest(res, `Category must be one of: ${PROVIDER_CATEGORIES.join(', ')}`);
      }
      const validationError = normalizeProviderFields(newProvider);
      if (validationError) {
        return sendBadRequest(res, validationError);
      }

      // Load current providers. Nothing readable means nothing configured yet,
      // which is the first-run case for a custom provider.
      const storedProviders = await configStore.readJson(PROVIDERS_FILE);
      const providers = Array.isArray(storedProviders?.providers) ? storedProviders.providers : [];

      // Check if provider with this ID already exists
      if (providers.find(p => p.id === newProvider.id)) {
        return sendBadRequest(res, `Provider with id '${newProvider.id}' already exists`);
      }

      // Handle API key encryption
      if (newProvider.apiKey && newProvider.apiKey !== '••••••••') {
        try {
          newProvider.apiKey = tokenStorageService.encryptString(newProvider.apiKey);
        } catch (error) {
          return sendInternalError(res, error, 'encrypt API key');
        }
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

      // Add new provider
      providers.push(newProvider);

      // Save updated providers
      await configStore.writeJson(PROVIDERS_FILE, { providers });
      await configCache.refreshProvidersCache();

      res.status(201).json({ message: 'Provider created successfully', provider: newProvider });
    } catch (error) {
      return sendInternalError(res, error, 'create provider');
    }
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
    try {
      const { providerId } = req.params;

      // Validate providerId for security
      if (!validateIdForPath(providerId, 'provider', res)) {
        return;
      }

      // Prevent deletion of built-in LLM providers
      if (BUILT_IN_LLM_PROVIDERS.includes(providerId)) {
        return sendBadRequest(
          res,
          `Cannot delete built-in provider '${providerId}'. Only custom providers can be deleted.`
        );
      }

      // A provider still holding the key of some models cannot go: they would
      // silently fall back to another key, or to none.
      const { data: models = [] } = configCache.getModels(true);
      const linkedModels = getLinkedModels(providerId, models).map(m => m.id);
      if (linkedModels.length > 0) {
        return res.status(409).json({
          error: `Provider '${providerId}' is used by ${linkedModels.length} model(s). Delete them or move them to another provider first.`,
          linkedModels
        });
      }

      // Load current providers
      const storedProviders = await configStore.readJson(PROVIDERS_FILE);
      const providers = Array.isArray(storedProviders?.providers) ? storedProviders.providers : [];

      // Find provider index
      const index = providers.findIndex(p => p.id === providerId);
      if (index === -1) {
        return sendNotFound(res, 'Provider');
      }

      // Remove provider
      providers.splice(index, 1);

      // Save updated providers
      await configStore.writeJson(PROVIDERS_FILE, { providers });
      await configCache.refreshProvidersCache();

      res.json({ message: 'Provider deleted successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'delete provider');
    }
  });

  /**
   * @swagger
   * /admin/providers/{providerId}/websearch-test:
   *   post:
   *     summary: Run a live connectivity test against a web search provider (Admin)
   *     description: >
   *       Issues one real, cache-bypassing search and reports a structured
   *       diagnosis. Answers the question the provider list cannot: can *this*
   *       server actually reach the engine? Qwant in particular is fronted by
   *       DataDome, which blocks data-centre IP ranges, so a correctly
   *       configured provider can still be unusable on a given host.
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
   *         description: A registered web search provider (brave, staan, qwant)
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               query:
   *                 type: string
   *                 description: Optional search terms to test with
   *               language:
   *                 type: string
   *                 description: Optional language/locale for the results
   *     responses:
   *       200:
   *         description: >
   *           The test ran. `success` reports whether the provider returned
   *           results; a blocked or misconfigured provider is a 200 with
   *           `success: false` and a diagnosis, not an HTTP error — the
   *           diagnostic itself succeeded.
   *       400:
   *         description: Invalid provider id or test query
   *       401:
   *         description: Admin authentication required
   *       404:
   *         description: Not a web search provider
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/admin/providers/:providerId/websearch-test'),
    adminAuth,
    async (req, res) => {
      const { providerId } = req.params;

      // Validate the id before it is used to look anything up.
      if (!validateIdForPath(providerId, 'provider', res)) {
        return;
      }

      // The registry of search providers is the allowlist: only engines this
      // server actually implements can be driven from here.
      if (!webSearchService.getProvider(providerId)) {
        return sendNotFound(res, 'Web search provider');
      }

      const rawQuery = req.body?.query;
      if (rawQuery !== undefined && typeof rawQuery !== 'string') {
        return sendBadRequest(res, 'query must be a string');
      }
      const query = (rawQuery || '').trim() || DEFAULT_TEST_QUERY;
      if (query.length > MAX_TEST_QUERY_LENGTH) {
        return sendBadRequest(res, `query must be ${MAX_TEST_QUERY_LENGTH} characters or fewer`);
      }

      const rawLanguage = req.body?.language;
      if (rawLanguage !== undefined && typeof rawLanguage !== 'string') {
        return sendBadRequest(res, 'language must be a string');
      }
      // Sanitized only when supplied: `sanitizeLanguageCode` substitutes 'en'
      // for anything it does not recognise, including undefined, and forcing
      // 'en' here would override the provider's own default for an admin who
      // asked for no particular language.
      const language = rawLanguage ? sanitizeLanguageCode(rawLanguage) : undefined;

      const startedAt = Date.now();
      try {
        const payload = await withTimeout(
          // skipCache: a cached hit would report success for an egress IP the
          // provider has since started blocking, which is the exact failure
          // this test exists to surface.
          webSearchService.search(query, { provider: providerId, language, skipCache: true }),
          TEST_TIMEOUT_MS
        );

        const results = Array.isArray(payload?.results) ? payload.results : [];
        const diagnosis = diagnoseSearchSuccess(payload, providerId);

        logger.info('Web search provider test completed', {
          component: 'AdminProviders',
          provider: providerId,
          status: diagnosis.status,
          resultCount: results.length,
          durationMs: Date.now() - startedAt
        });

        return res.json({
          success: diagnosis.status === 'ok',
          provider: providerId,
          providerLabel: providerLabel(providerId),
          query,
          durationMs: Date.now() - startedAt,
          resultCount: results.length,
          // Echoed as evidence the response was real; bounded so one test
          // cannot return an unbounded payload.
          results: results.slice(0, SAMPLE_RESULT_COUNT).map(result => ({
            title: truncate(result?.title),
            url: truncate(result?.url),
            description: truncate(result?.description)
          })),
          diagnosis,
          environment: describeOutboundPath(providerId)
        });
      } catch (error) {
        const diagnosis = diagnoseSearchError(error, providerId);

        logger.warn('Web search provider test failed', {
          component: 'AdminProviders',
          provider: providerId,
          status: diagnosis.status,
          code: diagnosis.code,
          blockedBy: diagnosis.blockedBy,
          durationMs: Date.now() - startedAt,
          error: error?.message
        });

        // 200, not an error status: the diagnostic ran and produced its
        // answer. "Qwant blocks this IP" is a finding, not a failed request,
        // and the UI renders it as a result rather than an API error.
        return res.json({
          success: false,
          provider: providerId,
          providerLabel: providerLabel(providerId),
          query,
          durationMs: Date.now() - startedAt,
          resultCount: 0,
          results: [],
          diagnosis,
          environment: describeOutboundPath(providerId)
        });
      }
    }
  );
}
