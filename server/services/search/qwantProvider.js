/**
 * Qwant web search provider.
 *
 * Qwant is the keyless counterpart to Brave in `WebSearchService`: an install
 * with no `BRAVE_SEARCH_API_KEY` can still give a model real search results.
 * It talks to the same JSON API the Qwant web front-end uses
 * (`https://api.qwant.com/v3/search/web`), which is undocumented but stable;
 * the request shape and the response layout below follow SearXNG's `qwant`
 * engine (searx/engines/qwant.py), the reference implementation for it.
 *
 * ## Testability
 *
 * Everything that decides *what* is requested and *what comes back* is a pure,
 * exported function — {@link resolveQwantLocale}, {@link buildQwantSearchUrl},
 * {@link parseQwantError}, {@link parseQwantWebResults} — so the interesting
 * behaviour is testable without a network, a mock framework or module
 * interception. The class itself takes an injectable `fetchImpl`, so
 * `new QwantSearchProvider({ fetchImpl })` exercises the full search path
 * (cache, retries, cookie round-trip, error mapping) against canned responses.
 *
 * ## DataDome
 *
 * Qwant fronts the API with DataDome. Two consequences shape this module:
 *
 *  1. Responses set a `datadome` cookie that must be echoed back on subsequent
 *     requests, or the bot score decays and requests start getting challenged.
 *     {@link QwantSearchProvider} caches the cookie per process and replays it.
 *  2. Requests from data-centre IP ranges (most cloud/VM/VPN hosting) are
 *     answered with an HTTP 403 whose body is `{"url": "https://geo.captcha-
 *     delivery.com/…"}` instead of results. That is a property of where the
 *     server runs, not of the query, so it is mapped to its own error code
 *     (`QWANT_CAPTCHA`) with an actionable message rather than a bare HTTP 403.
 *
 * @module services/search/qwantProvider
 */
import { SearchProvider } from './SearchProvider.js';
import { emitToolProgress } from '../loop/RunStream.js';
import config from '../../config.js';
import { throttledFetch } from '../../requestThrottler.js';
import { makeSearchCacheKey, getCachedSearch, setCachedSearch } from '../searchCache.js';
import logger from '../../utils/logger.js';

/** Base URL of Qwant's JSON search API; the category is appended to it. */
export const QWANT_API_URL = 'https://api.qwant.com/v3/search/';

/** Origin the API expects to be called from. */
export const QWANT_WEB_ORIGIN = 'https://www.qwant.com';

/**
 * Results Qwant returns for one web request. The API pages web results in tens;
 * asking for more silently returns ten, so the cap is made explicit here and
 * reported honestly by the tool definition.
 */
export const QWANT_MAX_WEB_RESULTS = 10;

/** Browser UA — the API answers a default Node/undici user agent with a challenge. */
export const QWANT_DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Locales Qwant accepts, in `language_REGION` form. An unsupported value makes
 * the API fall back to its own default, so the list is checked here to keep the
 * request predictable.
 */
export const QWANT_LOCALES = new Set([
  'bg_bg',
  'ca_ad',
  'ca_es',
  'ca_fr',
  'co_fr',
  'cs_cz',
  'da_dk',
  'de_at',
  'de_ch',
  'de_de',
  'el_gr',
  'en_au',
  'en_ca',
  'en_gb',
  'en_ie',
  'en_my',
  'en_nz',
  'en_us',
  'es_ad',
  'es_ar',
  'es_cl',
  'es_co',
  'es_es',
  'es_mx',
  'es_pe',
  'et_ee',
  'eu_es',
  'eu_fr',
  'fi_fi',
  'fr_ad',
  'fr_be',
  'fr_ca',
  'fr_ch',
  'fr_fr',
  'he_il',
  'hu_hu',
  'it_ch',
  'it_it',
  'ko_kr',
  'nb_no',
  'nl_be',
  'nl_nl',
  'pl_pl',
  'pt_ad',
  'pt_br',
  'pt_pt',
  'ro_ro',
  'ru_ru',
  'sv_se',
  'th_th',
  'tr_tr',
  'zh_cn',
  'zh_hk'
]);

/** Region assumed for a bare language tag (`"de"` → `de_DE`). */
const DEFAULT_REGION_BY_LANGUAGE = {
  bg: 'bg',
  ca: 'es',
  co: 'fr',
  cs: 'cz',
  da: 'dk',
  de: 'de',
  el: 'gr',
  en: 'us',
  es: 'es',
  et: 'ee',
  eu: 'es',
  fi: 'fi',
  fr: 'fr',
  he: 'il',
  hu: 'hu',
  it: 'it',
  ko: 'kr',
  nb: 'no',
  nl: 'nl',
  pl: 'pl',
  pt: 'pt',
  ro: 'ro',
  ru: 'ru',
  sv: 'se',
  th: 'th',
  tr: 'tr',
  zh: 'cn'
};

/** Locale used when the requested one is unknown or missing. */
export const QWANT_DEFAULT_LOCALE = 'en_US';

/**
 * Map an app/UI language onto a locale Qwant accepts.
 *
 * Accepts `"de"`, `"de-CH"`, `"de_ch"` and `"de_CH"` alike; anything Qwant does
 * not support falls back to a supported locale for the same language, and
 * finally to {@link QWANT_DEFAULT_LOCALE}.
 *
 * @param {string} [language] - Language or locale tag
 * @returns {string} Locale in Qwant's `xx_XX` form
 */
export function resolveQwantLocale(language) {
  if (!language || typeof language !== 'string') return QWANT_DEFAULT_LOCALE;

  const normalized = language.trim().toLowerCase().replace(/-/g, '_');
  if (!normalized) return QWANT_DEFAULT_LOCALE;

  const [lang, region] = normalized.split('_');
  if (region && QWANT_LOCALES.has(`${lang}_${region}`)) return format(lang, region);

  const fallbackRegion = DEFAULT_REGION_BY_LANGUAGE[lang];
  if (fallbackRegion && QWANT_LOCALES.has(`${lang}_${fallbackRegion}`)) {
    return format(lang, fallbackRegion);
  }

  return QWANT_DEFAULT_LOCALE;

  function format(l, r) {
    return `${l}_${r.toUpperCase()}`;
  }
}

/**
 * `tgp` ("test group") is an A/B bucket the front-end sends. Its value is
 * irrelevant, but a request without it is easier to single out as automated.
 * Drawn once per process rather than per request, so a burst of searches looks
 * like one browser session instead of one visitor per query.
 */
const TEST_GROUP_VALUE = 1 + Math.floor(Math.random() * 3);

/**
 * Build the URL for a Qwant search request.
 *
 * @param {Object} params
 * @param {string} params.query - Search terms
 * @param {number} [params.count=10] - Results per page (clamped to 1…{@link QWANT_MAX_WEB_RESULTS})
 * @param {number} [params.offset=0] - Index of the first result (paging)
 * @param {string} [params.locale='en_US'] - Locale in Qwant's `xx_XX` form
 * @param {number} [params.safesearch=1] - 0 off, 1 moderate, 2 strict
 * @param {string} [params.categ='web'] - Qwant search category
 * @param {string} [params.endpoint] - Override the API base URL
 * @param {number} [params.tgp] - Test-group bucket (defaults to the per-process value)
 * @returns {string} Fully-qualified request URL
 */
export function buildQwantSearchUrl({
  query,
  count = QWANT_MAX_WEB_RESULTS,
  offset = 0,
  locale = QWANT_DEFAULT_LOCALE,
  safesearch = 1,
  categ = 'web',
  endpoint = QWANT_API_URL,
  tgp = TEST_GROUP_VALUE
} = {}) {
  const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
  const params = new URLSearchParams({
    q: String(query ?? ''),
    count: String(clampCount(count)),
    locale,
    offset: String(Number.isInteger(offset) && offset > 0 ? offset : 0),
    device: 'desktop',
    tgp: String(tgp),
    safesearch: String(clampSafesearch(safesearch)),
    // Sent as the literal strings the front-end sends: `true` would serialize
    // as "True" from some callers and makes the request trivial to fingerprint.
    displayed: 'true',
    llm: 'true'
  });
  return `${base}${categ}?${params.toString()}`;
}

function clampCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n)) return QWANT_MAX_WEB_RESULTS;
  return Math.min(QWANT_MAX_WEB_RESULTS, Math.max(1, Math.trunc(n)));
}

function clampSafesearch(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0, Math.trunc(n)));
}

/**
 * Classify a Qwant response body as an error, or `null` when it carries results.
 *
 * Qwant answers failures with HTTP 200 and `status: "error"` as often as with a
 * real status code, and a DataDome challenge arrives as a 403 whose body is a
 * captcha URL — so the body, not the status code, is what has to be read.
 *
 * @param {Object|null} payload - Parsed response body (`null` when it was not JSON)
 * @param {number} [httpStatus] - HTTP status of the response
 * @returns {{code: string, message: string}|null}
 */
export function parseQwantError(payload, httpStatus) {
  const body = payload && typeof payload === 'object' ? payload : null;
  const data = body?.data && typeof body.data === 'object' ? body.data : {};

  // A DataDome challenge: the body is the captcha/interstitial URL, no results.
  if (typeof body?.url === 'string' && body.url) {
    return {
      code: 'QWANT_CAPTCHA',
      message:
        'Qwant answered with a DataDome captcha instead of results. Qwant challenges requests from data-centre IP ranges, so this usually means the server (or its outbound proxy) is on a hosting network Qwant does not trust. Route web search through a residential/allowed egress IP, or use Brave Search instead.'
    };
  }

  if (body && body.status === 'success') return null;

  if (data.error_code === 24) {
    return {
      code: 'QWANT_RATE_LIMITED',
      message: 'Qwant rate-limited this search (error 24). Retry in a few moments.'
    };
  }

  if (httpStatus === 403) {
    return {
      code: 'QWANT_ACCESS_DENIED',
      message: 'Qwant denied the search request (HTTP 403).'
    };
  }

  if (!body) {
    return {
      code: 'QWANT_INVALID_RESPONSE',
      message: `Qwant returned a response that is not JSON${
        httpStatus ? ` (HTTP ${httpStatus})` : ''
      }.`
    };
  }

  const detail = Array.isArray(data.message)
    ? data.message.join(', ')
    : data.message || body.message || 'unknown error';
  const code = data.error_code !== undefined ? ` (${data.error_code})` : '';
  return { code: 'QWANT_API_ERROR', message: `Qwant search failed: ${detail}${code}` };
}

/**
 * Extract web results from a successful Qwant response.
 *
 * Web responses group items by type under `data.result.items.mainline` — the
 * same list carries ads, related searches and instant answers, so only `web`
 * blocks are read and everything else (ads in particular) is dropped.
 *
 * @param {Object} payload - Parsed, successful response body
 * @returns {Array<{title: string, url: string, description: string, publishedDate?: string}>}
 */
export function parseQwantWebResults(payload) {
  const mainline = payload?.data?.result?.items?.mainline;
  if (!Array.isArray(mainline)) return [];

  const results = [];
  for (const block of mainline) {
    if (!block || block.type !== 'web' || !Array.isArray(block.items)) continue;
    for (const item of block.items) {
      if (!item?.url) continue;
      const result = {
        title: typeof item.title === 'string' ? item.title : '',
        url: item.url,
        description: typeof item.desc === 'string' ? item.desc : ''
      };
      const publishedDate = toIsoDate(item.date);
      if (publishedDate) result.publishedDate = publishedDate;
      results.push(result);
    }
  }
  return results;
}

/**
 * Qwant timestamps are seconds for web results and milliseconds for news.
 * Values far past "now" are read as milliseconds.
 * @param {number|undefined} value
 * @returns {string|undefined} ISO 8601 date, or undefined when absent/invalid
 */
function toIsoDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Read the `datadome` cookie out of a response's `Set-Cookie` header(s).
 * @param {Object} headers - Fetch-style headers
 * @returns {string|null} The cookie value, or null when the response set none
 */
export function extractDatadomeCookie(headers) {
  if (!headers) return null;
  let raw = [];
  if (typeof headers.getSetCookie === 'function') {
    raw = headers.getSetCookie() || [];
  } else if (typeof headers.raw === 'function') {
    raw = headers.raw()['set-cookie'] || [];
  } else if (typeof headers.get === 'function') {
    const single = headers.get('set-cookie');
    if (single) raw = [single];
  }

  for (const cookie of raw) {
    const match = /(?:^|[;,]\s*)datadome=([^;,\s]+)/i.exec(String(cookie));
    if (match) return match[1];
  }
  return null;
}

/**
 * Qwant search provider — no API key, no account, no per-query cost.
 */
class QwantSearchProvider extends SearchProvider {
  /**
   * @param {Object} [deps]
   * @param {(url: string, options: Object) => Promise<Object>} [deps.fetchImpl]
   *   Transport, injected by tests. Defaults to the throttled, proxy/TLS-aware
   *   fetch, queued under the `qwantSearch` tool id so the tool's
   *   `concurrency` / `requestDelayMs` apply.
   * @param {number} [deps.retryBackoffMs=1200] - Base backoff between retries;
   *   lowered by tests so exercising the retry budget costs milliseconds.
   */
  constructor({ fetchImpl, retryBackoffMs = 1200 } = {}) {
    super();
    this.fetchImpl = fetchImpl || ((url, options) => throttledFetch('qwantSearch', url, options));
    this.retryBackoffMs = retryBackoffMs;
    /** Last `datadome` cookie Qwant handed us; replayed on the next request. */
    this.datadomeCookie = null;
  }

  getName() {
    return 'qwant';
  }

  /** Keyless: nothing to configure, so it is always usable. */
  isConfigured() {
    return true;
  }

  /** Headers the API expects from a browser on qwant.com. */
  buildHeaders() {
    const headers = {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: QWANT_WEB_ORIGIN,
      Referer: `${QWANT_WEB_ORIGIN}/`,
      'User-Agent': config.QWANT_SEARCH_USER_AGENT || QWANT_DEFAULT_USER_AGENT
    };
    if (this.datadomeCookie) headers.Cookie = `datadome=${this.datadomeCookie}`;
    return headers;
  }

  /**
   * Run a web search.
   *
   * @param {string} query - Search terms
   * @param {Object} [options]
   * @param {string} [options.chatId] - Chat id, for tool-progress events
   * @param {string} [options.language] - Language/locale for the results
   * @param {number} [options.count] - Results to request (max {@link QWANT_MAX_WEB_RESULTS})
   * @param {number} [options.safesearch] - 0 off, 1 moderate, 2 strict
   * @returns {Promise<{results: Array<Object>}>}
   */
  async search(query, options = {}) {
    const { chatId, language, count = QWANT_MAX_WEB_RESULTS, safesearch = 1 } = options;
    const locale = resolveQwantLocale(language);
    const endpoint = config.QWANT_SEARCH_ENDPOINT || QWANT_API_URL;

    if (chatId) {
      emitToolProgress(chatId, {
        phase: 'search',
        message: query,
        data: { query, provider: 'qwant' }
      });
    }

    // Repeat queries across re-plan/verify rounds skip both the network and the
    // per-tool throttle — and, with Qwant, one fewer request past DataDome.
    // Locale and count participate: they change the response.
    const cacheKey = makeSearchCacheKey('qwant', query, { locale, count: clampCount(count) });
    const cached = getCachedSearch(cacheKey);
    if (cached) {
      logger.debug('Qwant search cache hit', { component: 'WebSearch', provider: 'qwant' });
      return cached;
    }

    const url = buildQwantSearchUrl({ query, count, locale, safesearch, endpoint });

    // Retry only transient throttling/unavailability. A captcha is not
    // transient — it is about the caller's IP — so it fails on the first try
    // instead of burning three requests and ~3s per search.
    const MAX_RETRIES = 2;
    let attempt = 0;

    while (true) {
      const res = await this.fetchOnce(url, endpoint);
      const payload = await readJson(res);
      const error = parseQwantError(payload, res.status);

      if (!error) {
        const results = parseQwantWebResults(payload).slice(0, clampCount(count));
        const result = { results };
        const parsedTtl = Number(config.SEARCH_CACHE_TTL_MS);
        const ttlMs = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 600000;
        setCachedSearch(cacheKey, result, ttlMs);
        return result;
      }

      const retryable =
        error.code === 'QWANT_RATE_LIMITED' || res.status === 429 || res.status === 503;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 5000)
            : this.retryBackoffMs * (attempt + 1);
        logger.warn('Qwant search rate-limited; backing off and retrying', {
          component: 'WebSearch',
          provider: 'qwant',
          status: res.status,
          attempt: attempt + 1,
          waitMs
        });
        await new Promise(resolve => setTimeout(resolve, waitMs));
        attempt += 1;
        continue;
      }

      logger.error('Qwant search failed', {
        component: 'WebSearch',
        provider: 'qwant',
        status: res.status,
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
   * "fetch failed". Caches the `datadome` cookie the response sets.
   * @param {string} url
   * @param {string} endpoint - for the error log only
   * @returns {Promise<Object>} the fetch Response
   */
  async fetchOnce(url, endpoint) {
    let res;
    try {
      res = await this.fetchImpl(url, { headers: this.buildHeaders() });
    } catch (error) {
      const causeMsg =
        error?.cause?.message || (typeof error?.cause === 'string' ? error.cause : undefined);
      logger.error('Qwant search network request failed', {
        component: 'WebSearch',
        provider: 'qwant',
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
        `Qwant search request failed: ${detailParts.filter(Boolean).join(' ')}`
      );
      wrapped.code = error?.code || error?.cause?.code || 'NETWORK_ERROR';
      wrapped.cause = error;
      throw wrapped;
    }

    const cookie = extractDatadomeCookie(res?.headers);
    if (cookie) this.datadomeCookie = cookie;
    return res;
  }
}

/**
 * Read a response body as JSON, returning null when it is not JSON at all
 * (an HTML challenge page, an empty body) so the caller classifies it via
 * {@link parseQwantError} rather than throwing a SyntaxError.
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

export { QwantSearchProvider };
export default QwantSearchProvider;
