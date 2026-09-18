/**
 * Staan (staan.ai) web search provider.
 *
 * Staan is a keyed, documented search API — https://docs.staan.ai/docs/web-search
 * — which makes it the third engine behind `WebSearchService`, alongside Brave
 * (keyed) and Qwant (keyless). It is the useful middle ground between the two:
 * unlike Qwant it is a real product with an account behind it, so it answers
 * requests from data-centre IP ranges instead of a DataDome captcha; unlike
 * Brave it takes European market targeting (`fr-fr`, `de-de`) as a first-class
 * request parameter.
 *
 * ## Testability
 *
 * Everything that decides *what* is requested and *what comes back* is a pure,
 * exported function — {@link resolveStaanMarket}, {@link buildStaanRequest},
 * {@link parseStaanError}, {@link parseStaanWebResults}, {@link planStaanPages}
 * — so the interesting behaviour is testable without a network, a mock
 * framework or module interception. The class takes an injectable `fetchImpl`
 * and `apiKeyResolver`, so `new StaanSearchProvider({ fetchImpl })` exercises
 * the full search path (cache, paging, retries, error mapping) against canned
 * responses.
 *
 * ## What the API fixes, and why this module is shaped around it
 *
 * Three constraints are enforced server-side and answered with HTTP 400, so
 * they are applied here rather than passed through and hoped for:
 *
 *  1. **`count` must equal 10.** It is not a page size the caller chooses, so
 *     it is never sent; the cap is applied to the results instead.
 *  2. **`offset` must be a multiple of 10, at most 30.** More than one page of
 *     results therefore means more than one request — see {@link planStaanPages}.
 *  3. **`include_domains` / `exclude_domains` are POST-only, mutually
 *     exclusive, 10 entries each.** {@link buildStaanRequest} picks the method
 *     from whether a filter is present.
 *
 * @module services/search/staanProvider
 */
import { SearchProvider } from './SearchProvider.js';
import { getStaanApiKey } from './staanApiKey.js';
import { resolveSearchLanguage } from './searchLanguage.js';
import { emitToolProgress } from '../loop/RunStream.js';
import config from '../../config.js';
import { throttledFetch } from '../../requestThrottler.js';
import { makeSearchCacheKey, getCachedSearch, setCachedSearch } from '../searchCache.js';
import logger from '../../utils/logger.js';

/** Staan's web search endpoint. */
export const STAAN_API_URL = 'https://api.staan.ai/v2/search/web';

/** Results per request. Fixed by the API: any other `count` is rejected with HTTP 400. */
export const STAAN_PAGE_SIZE = 10;

/** Largest `offset` the API accepts; beyond it the request is rejected. */
export const STAAN_MAX_OFFSET = 30;

/**
 * Most results one search can return: the last page the API will serve
 * (`offset=30`) plus its ten results. Reaching it costs four requests.
 */
export const STAAN_MAX_WEB_RESULTS = STAAN_MAX_OFFSET + STAAN_PAGE_SIZE;

/** Longest query the API documents. Longer ones are trimmed rather than risked. */
export const STAAN_MAX_QUERY_LENGTH = 400;

/** Most domains one `include_domains` / `exclude_domains` filter may carry. */
export const STAAN_MAX_DOMAIN_FILTERS = 10;

/**
 * Markets the API accepts, as `language-region`. An unsupported value is
 * rejected outright (HTTP 400, "market must be one of the following values"),
 * so the value is resolved against this list before it is sent.
 */
export const STAAN_MARKETS = new Set([
  'fr-fr',
  'de-de',
  'en-us',
  'en-gb',
  'en-fr',
  'en-ca',
  'en-au',
  'en-in',
  'en-ie',
  'en-nz',
  'en-za',
  'en-sg'
]);

/** Region assumed for a bare language tag (`"de"` → `de-de`). */
const DEFAULT_REGION_BY_LANGUAGE = {
  de: 'de',
  en: 'us',
  fr: 'fr'
};

/**
 * Market used when Staan does not serve the requested language at all.
 *
 * Reached only after {@link resolveSearchLanguage} has already applied the
 * user's language and the install's `platform.defaultLanguage`, so this is a
 * last resort rather than the usual path. Deliberately not the API's own
 * default: Staan defaults to `fr-fr`, which would answer an English install's
 * searches with French-market results.
 */
export const STAAN_DEFAULT_MARKET = 'en-us';

/**
 * Map an app/UI language onto a market Staan accepts.
 *
 * Accepts `"de"`, `"de-CH"`, `"de_CH"` and `"DE-ch"` alike. A region Staan does
 * not serve falls back to a supported market for the same language (`de-CH` →
 * `de-de`), and an unsupported language to {@link STAAN_DEFAULT_MARKET}.
 *
 * @param {string} [language] - Language or locale tag
 * @returns {string} Market in Staan's `xx-xx` form
 */
export function resolveStaanMarket(language) {
  if (!language || typeof language !== 'string') return STAAN_DEFAULT_MARKET;

  const normalized = language.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return STAAN_DEFAULT_MARKET;

  const [lang, region] = normalized.split('-');
  if (region && STAAN_MARKETS.has(`${lang}-${region}`)) return `${lang}-${region}`;

  const fallbackRegion = DEFAULT_REGION_BY_LANGUAGE[lang];
  if (fallbackRegion && STAAN_MARKETS.has(`${lang}-${fallbackRegion}`)) {
    return `${lang}-${fallbackRegion}`;
  }

  return STAAN_DEFAULT_MARKET;
}

/**
 * Normalize a domain filter: trimmed, lower-cased, without scheme, path or
 * `www.`, de-duplicated and capped at {@link STAAN_MAX_DOMAIN_FILTERS}. A model
 * asked for "results from intrafind.com" tends to produce
 * `https://intrafind.com/`, which the API rejects as not a domain.
 *
 * @param {string[]|string} [domains]
 * @returns {string[]} Cleaned domains (possibly empty)
 */
export function normalizeStaanDomains(domains) {
  const list = Array.isArray(domains) ? domains : domains ? [domains] : [];
  const seen = new Set();

  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const domain = entry
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[/?#].*$/, '')
      .replace(/:\d+$/, '');
    if (domain) seen.add(domain);
    if (seen.size >= STAAN_MAX_DOMAIN_FILTERS) break;
  }

  return [...seen];
}

/**
 * Build one Staan search request.
 *
 * GET carries everything except the domain filters, which the API accepts only
 * as JSON arrays on POST — so the method follows from whether a filter is in
 * play. `count` is never sent: the API fixes it at {@link STAAN_PAGE_SIZE} and
 * rejects any other value.
 *
 * @param {Object} params
 * @param {string} params.query - Search terms (trimmed to {@link STAAN_MAX_QUERY_LENGTH})
 * @param {string} [params.market='en-us'] - Market in Staan's `xx-xx` form
 * @param {number} [params.offset=0] - Index of the first result; rounded down to a multiple of 10
 * @param {string[]} [params.includeDomains] - Restrict results to these domains
 * @param {string[]} [params.excludeDomains] - Drop results from these domains
 * @param {string} [params.endpoint] - Override the API URL
 * @returns {{url: string, method: 'GET'|'POST', body: string|undefined}}
 */
export function buildStaanRequest({
  query,
  market = STAAN_DEFAULT_MARKET,
  offset = 0,
  includeDomains,
  excludeDomains,
  endpoint = STAAN_API_URL
} = {}) {
  const q = String(query ?? '').slice(0, STAAN_MAX_QUERY_LENGTH);
  const resolvedOffset = clampOffset(offset);

  const include = normalizeStaanDomains(includeDomains);
  // Mutually exclusive server-side: sending both is an HTTP 400. `include` is
  // the narrower intent, so it wins rather than failing the search outright.
  const exclude = include.length ? [] : normalizeStaanDomains(excludeDomains);

  if (include.length || exclude.length) {
    const body = { q, market, offset: resolvedOffset };
    if (include.length) body.include_domains = include;
    else body.exclude_domains = exclude;
    return { url: endpoint, method: 'POST', body: JSON.stringify(body) };
  }

  const params = new URLSearchParams({ q, market, offset: String(resolvedOffset) });
  return { url: `${endpoint}?${params.toString()}`, method: 'GET', body: undefined };
}

/**
 * Round an offset down onto the page grid the API accepts (a multiple of 10, at
 * most {@link STAAN_MAX_OFFSET}).
 * @param {number} offset
 * @returns {number}
 */
export function clampOffset(offset) {
  const n = Number(offset);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const onGrid = Math.floor(n / STAAN_PAGE_SIZE) * STAAN_PAGE_SIZE;
  return Math.min(STAAN_MAX_OFFSET, onGrid);
}

/**
 * Cap a requested result count to what one search can deliver.
 * @param {number} count
 * @returns {number}
 */
export function clampCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n)) return STAAN_PAGE_SIZE;
  return Math.min(STAAN_MAX_WEB_RESULTS, Math.max(1, Math.trunc(n)));
}

/**
 * The offsets needed to collect `count` results, given the API's fixed page
 * size. One page for the common case; a second request only once the caller
 * actually asks for more than ten.
 *
 * @param {number} count - Results wanted
 * @returns {number[]} Offsets to request, in order
 */
export function planStaanPages(count) {
  const wanted = clampCount(count);
  const pages = Math.ceil(wanted / STAAN_PAGE_SIZE);
  return Array.from({ length: pages }, (_, i) => i * STAAN_PAGE_SIZE);
}

/**
 * Classify a Staan response body as an error, or `null` when it carries results.
 *
 * The API answers failures in two shapes — its own
 * `{code, message}` and the framework's `{message, error, statusCode}`, where
 * `message` is an array of validation strings — so both are read and reduced to
 * one code plus a human-readable detail.
 *
 * @param {Object|null} payload - Parsed response body (`null` when it was not JSON)
 * @param {number} [httpStatus] - HTTP status of the response
 * @returns {{code: string, message: string}|null}
 */
export function parseStaanError(payload, httpStatus) {
  const body = payload && typeof payload === 'object' ? payload : null;
  const ok = typeof httpStatus === 'number' ? httpStatus >= 200 && httpStatus < 300 : true;

  if (ok && body && !body.statusCode && !body.code) return null;

  if (!body) {
    return {
      code: 'STAAN_INVALID_RESPONSE',
      message: `Staan returned a response that is not JSON${
        httpStatus ? ` (HTTP ${httpStatus})` : ''
      }.`
    };
  }

  const detail = Array.isArray(body.message)
    ? body.message.join('; ')
    : body.message || body.error || 'unknown error';

  if (httpStatus === 401 || httpStatus === 403 || body.code === 'INVALID_CREDENTIALS') {
    return {
      code: 'STAAN_UNAUTHORIZED',
      message: `Staan rejected the API key: ${detail}`
    };
  }

  if (httpStatus === 429) {
    return {
      code: 'STAAN_RATE_LIMITED',
      message: `Staan rate-limited this search: ${detail}`
    };
  }

  if (httpStatus === 400) {
    return {
      code: 'STAAN_BAD_REQUEST',
      message: `Staan rejected the search request: ${detail}`
    };
  }

  return {
    code: 'STAAN_API_ERROR',
    message: `Staan search failed: ${detail}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`
  };
}

/**
 * Extract web results from a successful Staan response.
 *
 * Mapped onto the shape every provider returns (`title` / `url` /
 * `description`), so an app can switch `websearch.provider` without the model
 * seeing a different contract; `snippet` is Staan's name for the description.
 * `hostname` is carried through because Staan supplies it and it is what a
 * model cites.
 *
 * @param {Object} payload - Parsed, successful response body
 * @returns {Array<{title: string, url: string, description: string, hostname?: string}>}
 */
export function parseStaanWebResults(payload) {
  const items = payload?.web?.results;
  if (!Array.isArray(items)) return [];

  const results = [];
  for (const item of items) {
    if (!item?.url || typeof item.url !== 'string') continue;
    const result = {
      title: typeof item.title === 'string' ? item.title : '',
      url: item.url,
      description: typeof item.snippet === 'string' ? item.snippet : ''
    };
    if (typeof item.hostname === 'string' && item.hostname) result.hostname = item.hostname;
    results.push(result);
  }
  return results;
}

/**
 * Staan search provider — keyed, and reachable from data-centre networks.
 */
class StaanSearchProvider extends SearchProvider {
  /**
   * @param {Object} [deps]
   * @param {(url: string, options: Object) => Promise<Object>} [deps.fetchImpl]
   *   Transport, injected by tests. Defaults to the throttled, proxy/TLS-aware
   *   fetch, queued under the `staanSearch` tool id so the tool's
   *   `concurrency` / `requestDelayMs` apply.
   * @param {() => string|undefined} [deps.apiKeyResolver] - Key lookup, injected by tests.
   * @param {(language?: string) => string} [deps.languageResolver] - Search-language
   *   resolution (user's language, else the install default), injected by tests.
   * @param {number} [deps.retryBackoffMs=1200] - Base backoff between retries;
   *   lowered by tests so exercising the retry budget costs milliseconds.
   */
  constructor({ fetchImpl, apiKeyResolver, languageResolver, retryBackoffMs = 1200 } = {}) {
    super();
    this.fetchImpl = fetchImpl || ((url, options) => throttledFetch('staanSearch', url, options));
    this.apiKeyResolver = apiKeyResolver || getStaanApiKey;
    this.languageResolver = languageResolver || resolveSearchLanguage;
    this.retryBackoffMs = retryBackoffMs;
  }

  getName() {
    return 'staan';
  }

  /** @returns {string|undefined} The configured API key, if any. */
  getApiKey() {
    return this.apiKeyResolver();
  }

  /** Staan needs an API key; without one every call would come back 401. */
  isConfigured() {
    return Boolean(this.getApiKey());
  }

  /**
   * Run a web search.
   *
   * @param {string} query - Search terms
   * @param {Object} [options]
   * @param {string} [options.chatId] - Chat id, for tool-progress events
   * @param {string} [options.language] - Language/locale for the results
   * @param {number} [options.count] - Results to return (max {@link STAAN_MAX_WEB_RESULTS});
   *   more than {@link STAAN_PAGE_SIZE} costs one request per further page
   * @param {string[]} [options.includeDomains] - Restrict results to these domains
   * @param {string[]} [options.excludeDomains] - Drop results from these domains
   * @param {boolean} [options.skipCache] - Bypass the result cache and always
   *   issue a request. Used by the admin connectivity test, where a cached hit
   *   would report success for a key that has since stopped working.
   * @returns {Promise<{results: Array<Object>}>}
   */
  async search(query, options = {}) {
    const {
      chatId,
      language,
      count = STAAN_PAGE_SIZE,
      includeDomains,
      excludeDomains,
      skipCache = false
    } = options;

    const apiKey = this.getApiKey();
    if (!apiKey) {
      // Phrased like Brave's so the admin diagnostics recognise it as a
      // configuration problem rather than an opaque provider failure.
      throw new Error(
        'Staan Search API key is not configured. Please configure it in the admin panel or set the STAAN_API_KEY environment variable.'
      );
    }

    // The user's language decides the market; `platform.defaultLanguage` stands
    // in when the caller had none to give (a workflow or agent run).
    const market = resolveStaanMarket(this.languageResolver(language));
    const endpoint = config.STAAN_SEARCH_ENDPOINT || STAAN_API_URL;
    const wanted = clampCount(count);

    if (chatId) {
      emitToolProgress(chatId, {
        phase: 'search',
        message: query,
        data: { query, provider: 'staan' }
      });
    }

    // Repeat queries across re-plan/verify rounds skip both the network and the
    // per-tool throttle. Market, count and the domain filters participate:
    // each of them changes the response.
    const include = normalizeStaanDomains(includeDomains);
    const exclude = include.length ? [] : normalizeStaanDomains(excludeDomains);
    const cacheKey = makeSearchCacheKey('staan', query, {
      market,
      count: wanted,
      include: include.join(','),
      exclude: exclude.join(',')
    });
    if (!skipCache) {
      const cached = getCachedSearch(cacheKey);
      if (cached) {
        logger.debug('Staan search cache hit', { component: 'WebSearch', provider: 'staan' });
        return cached;
      }
    }

    const results = [];
    const seenUrls = new Set();

    for (const offset of planStaanPages(wanted)) {
      let page;
      try {
        page = await this.fetchPage({
          query,
          market,
          offset,
          includeDomains: include,
          excludeDomains: exclude,
          endpoint,
          apiKey
        });
      } catch (error) {
        // The first page failing is the search failing. A later one failing is
        // not: we already have results to answer with, and losing them to
        // report a paging error would be a worse answer than a shorter one.
        if (offset === 0) throw error;
        logger.warn('Staan search page failed; returning the results collected so far', {
          component: 'WebSearch',
          provider: 'staan',
          offset,
          collected: results.length,
          errorCode: error?.code,
          errorMessage: error?.message
        });
        break;
      }

      for (const result of page) {
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        results.push(result);
      }

      // A short page is the last page — asking for the next one would spend a
      // request on an empty answer.
      if (page.length < STAAN_PAGE_SIZE || results.length >= wanted) break;
    }

    const payload = { results: results.slice(0, wanted) };
    const parsedTtl = Number(config.SEARCH_CACHE_TTL_MS);
    const ttlMs = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 600000;
    setCachedSearch(cacheKey, payload, ttlMs);
    return payload;
  }

  /**
   * Fetch and parse one page of results, retrying only transient throttling and
   * unavailability. A rejected key and a malformed request are not transient,
   * so they fail on the first attempt rather than burning the retry budget.
   *
   * @param {Object} params - see {@link buildStaanRequest}, plus `apiKey`
   * @returns {Promise<Array<Object>>} The page's results
   */
  async fetchPage({ query, market, offset, includeDomains, excludeDomains, endpoint, apiKey }) {
    const { url, method, body } = buildStaanRequest({
      query,
      market,
      offset,
      includeDomains,
      excludeDomains,
      endpoint
    });

    const MAX_RETRIES = 2;
    let attempt = 0;

    while (true) {
      const res = await this.fetchOnce(url, { method, body, apiKey }, endpoint);
      const payload = await readJson(res);
      const error = parseStaanError(payload, res.status);

      if (!error) return parseStaanWebResults(payload);

      const retryable =
        error.code === 'STAAN_RATE_LIMITED' || res.status === 429 || res.status === 503;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 5000)
            : this.retryBackoffMs * (attempt + 1);
        logger.warn('Staan search rate-limited; backing off and retrying', {
          component: 'WebSearch',
          provider: 'staan',
          status: res.status,
          attempt: attempt + 1,
          waitMs
        });
        await new Promise(resolve => setTimeout(resolve, waitMs));
        attempt += 1;
        continue;
      }

      logger.error('Staan search failed', {
        component: 'WebSearch',
        provider: 'staan',
        status: res.status,
        offset,
        errorCode: error.code,
        errorMessage: error.message
      });
      const err = new Error(error.message);
      err.code = error.code;
      err.status = res.status;
      throw err;
    }
  }

  /**
   * One request, with the network layer's failures wrapped so a proxy/TLS
   * problem is diagnosable from the log line instead of surfacing as a bare
   * "fetch failed".
   *
   * @param {string} url
   * @param {{method: string, body: string|undefined, apiKey: string}} request
   * @param {string} endpoint - for the error log only
   * @returns {Promise<Object>} the fetch Response
   */
  async fetchOnce(url, { method, body, apiKey }, endpoint) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`
    };
    if (body) headers['Content-Type'] = 'application/json';

    try {
      return await this.fetchImpl(url, { method, headers, body });
    } catch (error) {
      const causeMsg =
        error?.cause?.message || (typeof error?.cause === 'string' ? error.cause : undefined);
      logger.error('Staan search network request failed', {
        component: 'WebSearch',
        provider: 'staan',
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
        `Staan search request failed: ${detailParts.filter(Boolean).join(' ')}`
      );
      wrapped.code = error?.code || error?.cause?.code || 'NETWORK_ERROR';
      wrapped.cause = error;
      throw wrapped;
    }
  }
}

/**
 * Read a response body as JSON, returning null when it is not JSON at all (an
 * HTML error page from a proxy, an empty body) so the caller classifies it via
 * {@link parseStaanError} rather than throwing a SyntaxError.
 * @param {Object} res - fetch Response
 * @returns {Promise<Object|null>}
 */
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export { StaanSearchProvider };
export default StaanSearchProvider;
