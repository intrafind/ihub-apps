import { emitToolProgress } from './loop/RunStream.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';
import { makeSearchCacheKey, getCachedSearch, setCachedSearch } from './searchCache.js';
import logger from '../utils/logger.js';
import { getBraveApiKey } from './search/braveApiKey.js';
import { SearchProvider } from './search/SearchProvider.js';
import { resolveSearchLanguage } from './search/searchLanguage.js';
import { QwantSearchProvider } from './search/qwantProvider.js';
import { StaanSearchProvider } from './search/staanProvider.js';

/**
 * Language tags Brave accepts as `search_lang`, mapped onto the exact spelling
 * Brave wants.
 *
 * Brave validates this parameter, and its spellings are not all the obvious
 * ISO 639-1 ones: Japanese is `jp`, Chinese is `zh-hans` / `zh-hant`,
 * Portuguese is `pt-br` / `pt-pt`, and Greek and Indonesian are not supported
 * at all. So this is a lookup, not a pass-through — a tag that is not a key
 * here means the request goes out with no language parameters, which is exactly
 * how Brave search behaved before this existed. The cost of a miss is a search
 * that is not language-targeted, never a failed one.
 *
 * Values transcribed from Brave's own client, which publishes the enum:
 * https://github.com/brave/brave-search-mcp-server — `src/tools/web/params.ts`.
 */
export const BRAVE_SEARCH_LANGUAGES = Object.freeze({
  ar: 'ar',
  bg: 'bg',
  bn: 'bn',
  ca: 'ca',
  cs: 'cs',
  da: 'da',
  de: 'de',
  en: 'en',
  'en-gb': 'en-gb',
  es: 'es',
  et: 'et',
  eu: 'eu',
  fi: 'fi',
  fr: 'fr',
  gl: 'gl',
  gu: 'gu',
  he: 'he',
  hi: 'hi',
  hr: 'hr',
  hu: 'hu',
  is: 'is',
  it: 'it',
  ja: 'jp',
  jp: 'jp',
  kn: 'kn',
  ko: 'ko',
  lt: 'lt',
  lv: 'lv',
  ml: 'ml',
  mr: 'mr',
  ms: 'ms',
  nb: 'nb',
  nl: 'nl',
  pa: 'pa',
  pl: 'pl',
  pt: 'pt-pt',
  'pt-br': 'pt-br',
  'pt-pt': 'pt-pt',
  ro: 'ro',
  ru: 'ru',
  sk: 'sk',
  sl: 'sl',
  sr: 'sr',
  sv: 'sv',
  ta: 'ta',
  te: 'te',
  th: 'th',
  tr: 'tr',
  uk: 'uk',
  vi: 'vi',
  zh: 'zh-hans',
  'zh-cn': 'zh-hans',
  'zh-hans': 'zh-hans',
  'zh-hant': 'zh-hant',
  'zh-hk': 'zh-hant',
  'zh-mo': 'zh-hant',
  'zh-sg': 'zh-hans',
  'zh-tw': 'zh-hant'
});

/**
 * Regions Brave accepts as `country`, from the same source. (Brave also accepts
 * the pseudo-value `ALL`, which is its default behaviour and never needs sending.)
 */
export const BRAVE_COUNTRIES = new Set([
  'AR',
  'AT',
  'AU',
  'BE',
  'BR',
  'CA',
  'CH',
  'CL',
  'CN',
  'DE',
  'DK',
  'ES',
  'FI',
  'FR',
  'GB',
  'HK',
  'ID',
  'IN',
  'IT',
  'JP',
  'KR',
  'MX',
  'MY',
  'NL',
  'NO',
  'NZ',
  'PH',
  'PL',
  'PT',
  'RU',
  'SA',
  'SE',
  'TR',
  'TW',
  'US',
  'ZA'
]);

/**
 * Map a language tag onto Brave's language/region query parameters.
 *
 * Brave takes the two separately — `search_lang` and `country` as a
 * 2-character code (its own example is `country=DE&search_lang=de`). The full
 * tag is looked up first so `en-GB` and `pt-BR` reach Brave's hyphenated codes,
 * then the bare language, so `de-LI` still targets German while dropping a
 * region Brave does not list.
 *
 * @param {string} [language] - Language or locale tag
 * @returns {{search_lang?: string, country?: string}} Params to add, possibly empty
 */
export function resolveBraveSearchParams(language) {
  if (!language || typeof language !== 'string') return {};

  const normalized = language.trim().toLowerCase().replace(/_/g, '-');
  const [lang, region] = normalized.split('-');

  const searchLang = BRAVE_SEARCH_LANGUAGES[normalized] || BRAVE_SEARCH_LANGUAGES[lang];
  // A country without a language Brave knows would narrow the market while
  // leaving the content language to Brave's default, which is not what the
  // caller asked for.
  if (!searchLang) return {};

  const params = { search_lang: searchLang };
  if (region) {
    const country = region.toUpperCase();
    if (BRAVE_COUNTRIES.has(country)) params.country = country;
  }
  return params;
}

/**
 * Brave Search Provider
 */
class BraveSearchProvider extends SearchProvider {
  /**
   * @param {Object} [deps]
   * @param {(url: string, options: Object) => Promise<Object>} [deps.fetchImpl]
   *   Transport, injected by tests. Defaults to the throttled, proxy/TLS-aware
   *   fetch queued under the `braveSearch` tool id.
   * @param {(language?: string) => string} [deps.languageResolver] - Search-language
   *   resolution (user's language, else the install default), injected by tests.
   */
  constructor({ fetchImpl, languageResolver } = {}) {
    super();
    this.fetchImpl = fetchImpl || ((url, options) => throttledFetch('braveSearch', url, options));
    this.languageResolver = languageResolver || resolveSearchLanguage;
  }

  getName() {
    return 'brave';
  }

  /**
   * Get API key with fallback logic:
   * 1. Check provider-level API key (from providers.json)
   * 2. Fallback to environment variable
   */
  getApiKey() {
    return getBraveApiKey();
  }

  /** Brave needs a subscription token; without one every call would 401. */
  isConfigured() {
    return Boolean(this.getApiKey());
  }

  /**
   * @param {string} query - The search query
   * @param {Object} [options]
   * @param {string} [options.chatId] - Chat id, for tool-progress events
   * @param {boolean} [options.skipCache] - Bypass the result cache and always
   *   issue a request (used by the admin connectivity test, where a cached hit
   *   would report success for credentials that have since stopped working).
   * @returns {Promise<{results: Array<Object>}>}
   */
  async search(query, options = {}) {
    const { chatId, language, skipCache = false } = options;
    const apiKey = this.getApiKey();

    if (!apiKey) {
      throw new Error(
        'Brave Search API key is not configured. Please configure it in the admin panel or set BRAVE_SEARCH_API_KEY environment variable.'
      );
    }

    const endpoint =
      config.BRAVE_SEARCH_ENDPOINT || 'https://api.search.brave.com/res/v1/web/search';

    if (chatId) {
      emitToolProgress(chatId, {
        phase: 'search',
        message: query,
        data: { query, provider: 'brave' }
      });
    }

    // Query cache. Across re-plan/verify rounds the same query recurs; serving
    // a repeat from cache skips both the network and the ~1 req/s throttle,
    // which is the difference between a result and a 429 (run wf-exec-f4f70e84).
    // The user's language decides the market; `platform.defaultLanguage` stands
    // in when the caller had none to give (a workflow or agent run).
    const searchLanguage = this.languageResolver(language);
    let braveParams = resolveBraveSearchParams(searchLanguage);

    // Language participates in the key: without it the first caller's language
    // would be served to every later caller asking in another one.
    let cacheKey = makeSearchCacheKey('brave', query, braveParams);
    if (!skipCache) {
      const cached = getCachedSearch(cacheKey);
      if (cached) {
        logger.debug('Brave search cache hit', { component: 'WebSearch', provider: 'brave' });
        return cached;
      }
    }

    // Brave's Free plan is rate-limited to ~1 request/second, so an agent that
    // fires several searches in a turn reliably trips HTTP 429. Retry a bounded
    // number of times with backoff (honoring Retry-After) so transient
    // rate-limit / 503 responses recover instead of failing the whole step.
    const MAX_RETRIES = 2;
    let res;
    let attempt = 0;

    while (true) {
      try {
        const params = new URLSearchParams({ q: query, ...braveParams });
        res = await this.fetchImpl(`${endpoint}?${params.toString()}`, {
          headers: {
            'X-Subscription-Token': apiKey,
            Accept: 'application/json'
          }
        });
      } catch (error) {
        // Network/proxy failures (ECONNREFUSED, ETIMEDOUT, TLS errors, proxy unreachable, ...)
        // surface here as a thrown Error from node-fetch. Without this branch the upstream
        // wrapper only sees `error.message` and drops the code/cause, making proxy issues
        // impossible to diagnose from the logs.
        const causeMsg =
          error?.cause?.message || (typeof error?.cause === 'string' ? error.cause : undefined);
        logger.error('Brave search network request failed', {
          component: 'WebSearch',
          provider: 'brave',
          endpoint,
          errorName: error?.name,
          errorCode: error?.code || error?.cause?.code,
          errorMessage: error?.message,
          errorCause: causeMsg,
          hint: 'If a proxy is configured, verify HTTPS_PROXY/HTTP_PROXY, ssl.domainWhitelist, and proxy.urlPatterns in platform.json.'
        });
        const detailParts = [error?.message];
        if (error?.code) detailParts.push(`code=${error.code}`);
        if (causeMsg) detailParts.push(`cause=${causeMsg}`);
        const wrapped = new Error(
          `Brave search request failed: ${detailParts.filter(Boolean).join(' ')}`
        );
        wrapped.code = error?.code || error?.cause?.code || 'NETWORK_ERROR';
        wrapped.cause = error;
        throw wrapped;
      }

      if (res.ok) break;

      // Brave validates `search_lang` / `country` and the accepted values are
      // not published anywhere readable without a dashboard login, so a wrong
      // entry in the allowlist above must not cost the search. On a validation
      // refusal, retry once with the language dropped — the result is a
      // non-targeted search rather than no search at all, and the log line says
      // which language to remove from the list.
      if ((res.status === 422 || res.status === 400) && Object.keys(braveParams).length > 0) {
        let bodyPreview = '';
        try {
          bodyPreview = (await res.text()).slice(0, 500);
        } catch {
          // A body we cannot read is not worth failing the retry over.
        }
        logger.warn('Brave rejected the request; retrying without the language parameters', {
          component: 'WebSearch',
          provider: 'brave',
          status: res.status,
          language: searchLanguage,
          braveParams,
          // Brave names the offending parameter here, which is what says whether
          // the language was actually the problem or the query was.
          bodyPreview
        });
        braveParams = {};
        // The key has to describe what was really requested, or an untargeted
        // result would be served to later callers under a targeted key.
        cacheKey = makeSearchCacheKey('brave', query, braveParams);
        continue;
      }

      // Retry transient rate-limit (429) and server (503) responses.
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 5000)
            : 1200 * (attempt + 1);
        logger.warn('Brave search rate-limited; backing off and retrying', {
          component: 'WebSearch',
          provider: 'brave',
          status: res.status,
          attempt: attempt + 1,
          waitMs
        });
        await new Promise(resolve => setTimeout(resolve, waitMs));
        attempt += 1;
        continue;
      }

      let bodyPreview = '';
      try {
        bodyPreview = (await res.text()).slice(0, 500);
      } catch {
        // ignore body read errors
      }
      logger.error('Brave search returned non-OK status', {
        component: 'WebSearch',
        provider: 'brave',
        status: res.status,
        statusText: res.statusText,
        bodyPreview
      });
      const err = new Error(
        `Brave search failed with status ${res.status}${res.statusText ? ` (${res.statusText})` : ''}`
      );
      err.code = `HTTP_${res.status}`;
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const results = [];

    if (data.web && Array.isArray(data.web.results)) {
      for (const item of data.web.results) {
        results.push({
          title: item.title,
          url: item.url,
          description: item.description,
          language: item.language
        });
      }
    }

    const payload = { results };
    // Cache only successful responses (errors throw above and never reach here),
    // so a transient 429 is never cached. TTL is configurable; default 10 min —
    // long enough to dedupe within a multi-round run, short enough to stay fresh.
    const parsedTtl = Number(config.SEARCH_CACHE_TTL_MS);
    const ttlMs = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 600000;
    setCachedSearch(cacheKey, payload, ttlMs);
    return payload;
  }
}

/**
 * Web Search Service
 * Unified interface for multiple search providers
 */
class WebSearchService {
  constructor() {
    this.providers = new Map();
    this.defaultProvider = null;

    // Register built-in providers. Brave is registered first and so stays the
    // default; Staan is the other keyed engine, and Qwant the keyless
    // alternative an install can use with no account or API key at all.
    this.registerProvider(new BraveSearchProvider());
    this.registerProvider(new StaanSearchProvider());
    this.registerProvider(new QwantSearchProvider());
  }

  /**
   * Register a search provider
   * @param {SearchProvider} provider - The search provider instance
   */
  registerProvider(provider) {
    if (!(provider instanceof SearchProvider)) {
      throw new Error('Provider must extend SearchProvider class');
    }

    this.providers.set(provider.getName(), provider);

    // Set first registered provider as default
    if (!this.defaultProvider) {
      this.defaultProvider = provider.getName();
    }
  }

  /**
   * Get available provider names
   * @returns {Array<string>} Array of provider names
   */
  getAvailableProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * Get a registered provider instance.
   * @param {string} providerName
   * @returns {SearchProvider|undefined}
   */
  getProvider(providerName) {
    return this.providers.get(providerName);
  }

  /**
   * Whether a provider is registered and ready to run searches (credentials
   * present, where it needs any). Callers use this to resolve
   * `websearch.provider: "auto"` onto a provider that will actually answer,
   * instead of offering the model a tool whose every call fails on a missing key.
   * @param {string} providerName
   * @returns {boolean}
   */
  isProviderConfigured(providerName) {
    const provider = this.providers.get(providerName);
    if (!provider) return false;
    try {
      return provider.isConfigured();
    } catch (error) {
      logger.error('Failed to determine search provider configuration', {
        component: 'WebSearch',
        provider: providerName,
        error
      });
      return false;
    }
  }

  /**
   * Set the default provider
   * @param {string} providerName - Name of the provider to set as default
   */
  setDefaultProvider(providerName) {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider '${providerName}' is not registered`);
    }
    this.defaultProvider = providerName;
  }

  /**
   * Perform a web search using the specified or default provider
   * @param {string} query - The search query
   * @param {Object} options - Search options
   * @param {string} options.provider - Provider to use (optional, uses default if not specified)
   * @returns {Promise<Object>} Search results
   */
  async search(query, options = {}) {
    if (!query) {
      throw new Error('Query parameter is required');
    }

    const providerName = options.provider || this.defaultProvider;
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new Error(`Provider '${providerName}' is not available`);
    }

    try {
      return await provider.search(query, options);
    } catch (error) {
      logger.error('Web search provider failed', {
        component: 'WebSearch',
        provider: providerName,
        errorName: error?.name,
        errorCode: error?.code,
        errorMessage: error?.message,
        errorCause: error?.cause?.message || error?.cause
      });
      const wrapped = new Error(`Search failed with ${providerName}: ${error.message}`);
      // Preserve original code/cause so admins (and the chat tool error report)
      // can see proxy/network/TLS specifics instead of a generic "Search failed" line.
      if (error?.code) wrapped.code = error.code;
      wrapped.cause = error;
      throw wrapped;
    }
  }
}

// Create singleton instance
const webSearchService = new WebSearchService();

export default webSearchService;
export {
  SearchProvider,
  BraveSearchProvider,
  QwantSearchProvider,
  StaanSearchProvider,
  WebSearchService
};
