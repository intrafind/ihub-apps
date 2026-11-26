// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * SearXNG web search provider.
 *
 * SearXNG is a metasearch gateway the customer runs themselves; it answers a
 * query by asking the engines its operator configured. iHub is a plain HTTP
 * client of its documented search API (`GET <instance>/search?format=json`):
 * nothing of SearXNG is bundled, linked or copied here, and the instance is a
 * separate process the customer operates (see `docs/web-tools.md`).
 *
 * What differs from the other engines:
 *
 *  - **The address is configuration.** There is no vendor endpoint; the
 *    installation's `instanceUrl` is the base URL, so the provider reads it on
 *    every call (and the admin's test passes the unsaved value in `options`).
 *  - **No API key exists.** SearXNG has no authentication. When a reverse proxy
 *    in front of it asks for one, the installation references a credential that
 *    is sent as the `Authorization` header (`websearchConfig.js`).
 *  - **The address is checked.** The URL comes from an admin, so every request
 *    goes through the SSRF guard (`utils/ssrfGuard.js`, REVIEW.md A01) with
 *    `allowPrivate`: an instance on the company network just works, while a
 *    loopback, link-local or cloud-metadata address is refused unless the host
 *    is trusted (`ssrf.allowedHosts` or `ssl.domainWhitelist`). The connection
 *    is pinned to the checked address, and a redirect is never followed (a
 *    3xx is reported as an error), since each hop would need its own check.
 *  - **JSON is off by default.** An instance only answers `format=json` when
 *    its `settings.yml` lists `json` under `search.formats`; otherwise it
 *    answers HTTP 403. That is by far the most common failure, so it has its
 *    own error code and remedy.
 *  - **No result count.** A page holds whatever the engines returned; the
 *    provider keeps the first `count`.
 *  - **`time_range` has no `week`**, and only some engines honour it.
 *
 * Everything that decides what is requested and what comes back is a pure,
 * exported function ({@link searxngTimeRange}, {@link buildSearxngSearchUrl},
 * {@link parseSearxngError}, {@link parseSearxngResults}), and the class takes
 * an injectable `fetchImpl`, so the whole path is tested without a network.
 *
 * @module services/search/searxngProvider
 */
import { SearchProvider } from './SearchProvider.js';
import { networkFailure, readJsonBody, searchFailure, waitBeforeRetry } from './providerRequest.js';
import { resolveSearchLanguage } from './searchLanguage.js';
import { resolveSearxngSettings } from './websearchConfig.js';
import { emitToolProgress } from '../loop/RunStream.js';
import config from '../../config.js';
import { throttledFetch } from '../../requestThrottler.js';
import { makeSearchCacheKey, getCachedSearch, setCachedSearch } from '../searchCache.js';
import logger from '../../utils/logger.js';
import { isSsrfTrustedHost } from '../../utils/httpConfig.js';
import { assertPublicTarget, createPinnedLookup } from '../../utils/ssrfGuard.js';

/** Most results one search returns (a SearXNG page usually holds more; the cap keeps the tool honest). */
export const SEARXNG_MAX_WEB_RESULTS = 20;

/** Results returned when the caller does not say. */
export const SEARXNG_DEFAULT_RESULTS = 10;

/** What to check when the instance cannot be reached. */
const SELF_HOSTED_HINT =
  'A self-signed or private-CA certificate needs ssl.ignoreInvalidCertificates and the host in ssl.domainWhitelist (platform.json). With an outbound proxy configured, an instance on the internal network needs a proxy bypass.';

/** Identifies iHub to the instance (and its logs); an operator can allow it by name. */
export const SEARXNG_USER_AGENT = 'iHub-Apps (web search)';

/**
 * SearXNG's `time_range` values for the tools' `freshness` values. SearXNG has
 * no `week`: `month` is the nearest window that contains it, and the shared
 * search body drops the dated results older than a week afterwards.
 */
export const SEARXNG_TIME_RANGES = Object.freeze({
  day: 'day',
  week: 'month',
  month: 'month',
  year: 'year'
});

/**
 * @param {unknown} freshness - `day` | `week` | `month` | `year`
 * @returns {'day'|'month'|'year'|null}
 */
export function searxngTimeRange(freshness) {
  const key = typeof freshness === 'string' ? freshness.trim().toLowerCase() : '';
  return Object.hasOwn(SEARXNG_TIME_RANGES, key) ? SEARXNG_TIME_RANGES[key] : null;
}

function clampCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n)) return SEARXNG_DEFAULT_RESULTS;
  return Math.min(SEARXNG_MAX_WEB_RESULTS, Math.max(1, Math.trunc(n)));
}

function clampSafesearch(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0, Math.trunc(n)));
}

/**
 * The language SearXNG gets: the tag as the caller wrote it with `_` read as
 * `-` (`de`, `de-CH`, `en-GB`). SearXNG takes both a bare language and a
 * language-region and answers with its own default for one it does not know,
 * so nothing is mapped or rejected here.
 *
 * @param {string} [language]
 * @returns {string|undefined}
 */
export function resolveSearxngLanguage(language) {
  if (typeof language !== 'string') return undefined;
  const tag = language.trim().replaceAll('_', '-');
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(tag) ? tag : undefined;
}

/**
 * Build the URL of a search request.
 *
 * @param {Object} params
 * @param {string} params.baseUrl - the instance, as {@link normalizeSearxngBaseUrl} returns it
 * @param {string} params.query
 * @param {string} [params.language]
 * @param {'day'|'month'|'year'|null} [params.timeRange]
 * @param {number} [params.safesearch=1] - 0 off, 1 moderate, 2 strict
 * @param {number} [params.pageno=1]
 * @returns {string}
 */
export function buildSearxngSearchUrl({
  baseUrl,
  query,
  language,
  timeRange,
  safesearch = 1,
  pageno = 1
}) {
  const params = new URLSearchParams({
    q: String(query ?? ''),
    format: 'json',
    categories: 'general',
    pageno: String(Number.isInteger(pageno) && pageno > 0 ? pageno : 1),
    safesearch: String(clampSafesearch(safesearch))
  });
  if (language) params.set('language', language);
  if (timeRange) params.set('time_range', timeRange);
  return `${baseUrl}/search?${params.toString()}`;
}

/**
 * The engines that did not answer, as `[name, reason]` pairs.
 * @param {Object|null} payload
 * @returns {string[]} e.g. `['google: CAPTCHA', 'bing: timeout']`
 */
export function unresponsiveEngines(payload) {
  const list = payload?.unresponsive_engines;
  if (!Array.isArray(list)) return [];
  return list
    .filter(entry => Array.isArray(entry) && typeof entry[0] === 'string')
    .map(([name, reason]) => (reason ? `${name}: ${reason}` : name));
}

/**
 * Classify a response as an error, or `null` when it carries results.
 *
 * @param {Object|null} payload - parsed body (`null` when it was not JSON)
 * @param {number} [httpStatus]
 * @param {string|null} [location] - the `Location` header of a redirect
 * @returns {{code: string, message: string}|null}
 */
export function parseSearxngError(payload, httpStatus, location) {
  if (httpStatus >= 300 && httpStatus < 400) {
    return {
      code: 'SEARXNG_REDIRECT',
      message: `The SearXNG instance answered a redirect (HTTP ${httpStatus}${location ? ` to ${location}` : ''}). iHub does not follow redirects for an engine, so use the URL it leads to as the instance URL.`
    };
  }
  if (httpStatus === 401) {
    return {
      code: 'SEARXNG_UNAUTHORIZED',
      message:
        'The SearXNG instance (or the reverse proxy in front of it) answered HTTP 401: it wants a credential this server did not send, or did not accept.'
    };
  }
  if (httpStatus === 403) {
    return {
      code: 'SEARXNG_FORBIDDEN',
      message:
        'The SearXNG instance answered HTTP 403. SearXNG answers 403 when "json" is not listed under search.formats in its settings.yml (the default); a reverse proxy or the bot limiter can answer 403 as well.'
    };
  }
  if (httpStatus === 404) {
    return {
      code: 'SEARXNG_NOT_FOUND',
      message:
        'The SearXNG instance answered HTTP 404: the URL does not lead to a SearXNG /search endpoint. Use the base URL of the instance (including its path, if it runs under one).'
    };
  }
  if (httpStatus === 429) {
    return {
      code: 'SEARXNG_RATE_LIMITED',
      message:
        'The SearXNG instance answered HTTP 429: its limiter is throttling this server. Retry in a few moments.'
    };
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    return {
      code: 'SEARXNG_INVALID_RESPONSE',
      message: `The SearXNG instance returned something that is not a SearXNG JSON search result${
        httpStatus ? ` (HTTP ${httpStatus})` : ''
      }. The URL may point to another service or a login page.`
    };
  }
  if (httpStatus && httpStatus >= 400) {
    return {
      code: 'SEARXNG_API_ERROR',
      message: `The SearXNG instance answered HTTP ${httpStatus}.`
    };
  }
  if (payload.results.length === 0) {
    const down = unresponsiveEngines(payload);
    if (down.length) {
      return {
        code: 'SEARXNG_ENGINES_UNAVAILABLE',
        message: `The SearXNG instance found nothing, and these of its engines did not answer: ${down.join(', ')}.`
      };
    }
  }
  return null;
}

/** Plain text of a snippet: tags dropped, entities of the usual few decoded, white space collapsed. */
function plainText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  // SearXNG sends ISO strings without a zone for some engines; they are UTC.
  const text = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value) || !/T/.test(value) ? value : `${value}Z`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The web results of a SearXNG response in the shape every provider returns.
 * Only http(s) results with a URL are kept; the answers, infoboxes and
 * suggestions SearXNG also sends are not search results and are dropped.
 *
 * @param {Object} payload - parsed, successful body
 * @returns {Array<{title: string, url: string, description: string, publishedDate?: string}>}
 */
export function parseSearxngResults(payload) {
  const items = Array.isArray(payload?.results) ? payload.results : [];
  const seen = new Set();
  const results = [];
  for (const item of items) {
    if (!item || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const result = {
      title: plainText(item.title),
      url: item.url,
      description: plainText(item.content)
    };
    const publishedDate = isoDate(item.publishedDate);
    if (publishedDate) result.publishedDate = publishedDate;
    results.push(result);
  }
  return results;
}

/**
 * The SSRF check of the instance the admin configured, before a request.
 *
 * A host on `ssrf.allowedHosts` or `ssl.domainWhitelist` is the admin's own
 * decision and passes unchecked. Any other host must resolve to addresses the
 * guard accepts with `allowPrivate` (company-internal ranges pass; loopback,
 * link-local, reserved and cloud-metadata addresses do not), and the connection
 * is then pinned to those addresses.
 *
 * @param {string} baseUrl - the normalized instance URL
 * @returns {Promise<{ lookup?: Function }>} the DNS lookup that pins the connection (none for a trusted host)
 * @throws {Error} with code `SEARXNG_TARGET_BLOCKED` when the address is refused
 */
export async function checkSearxngTarget(baseUrl) {
  const url = new URL(baseUrl);
  if (isSsrfTrustedHost(url.hostname)) return {};
  const verdict = await assertPublicTarget(url, { allowPrivate: true });
  if (!verdict.ok) {
    const error = new Error(
      `The SearXNG instance address ${url.hostname} is refused: ${verdict.reason}. A loopback, link-local or metadata address, or a name that does not resolve, needs the host on ssrf.allowedHosts (Admin → Security).`
    );
    error.code = 'SEARXNG_TARGET_BLOCKED';
    throw error;
  }
  return { lookup: createPinnedLookup(verdict.addresses, { allowPrivate: true }) };
}

/**
 * SearXNG search provider: no vendor, no API key, the customer's own gateway.
 */
class SearxngSearchProvider extends SearchProvider {
  /**
   * @param {Object} [deps]
   * @param {(url: string, options: Object) => Promise<Object>} [deps.fetchImpl]
   *   Transport, injected by tests. Defaults to the throttled, proxy/TLS-aware
   *   `httpFetch` (so `ssl.ignoreInvalidCertificates` and `ssl.domainWhitelist`
   *   apply to a private CA), queued under the `searxngSearch` tool id.
   * @param {() => Object} [deps.settingsResolver] - the installation's settings
   *   ({@link resolveSearxngSettings}), injected by tests
   * @param {(language?: string) => string} [deps.languageResolver]
   * @param {(baseUrl: string) => Promise<{lookup?: Function}>} [deps.targetGuard] - the
   *   SSRF check ({@link checkSearxngTarget}), injected by tests
   * @param {number} [deps.retryBackoffMs=1200]
   */
  constructor({
    fetchImpl,
    settingsResolver,
    languageResolver,
    targetGuard,
    retryBackoffMs = 1200
  } = {}) {
    super();
    this.targetGuard = targetGuard || checkSearxngTarget;
    this.fetchImpl = fetchImpl || ((url, options) => throttledFetch('searxngSearch', url, options));
    this.settingsResolver = settingsResolver || resolveSearxngSettings;
    this.languageResolver = languageResolver || resolveSearchLanguage;
    this.retryBackoffMs = retryBackoffMs;
  }

  getName() {
    return 'searxng';
  }

  /** SearXNG answers once the installation has the URL of its instance. */
  isConfigured() {
    return Boolean(this.settingsResolver().baseUrl);
  }

  /**
   * Run a web search.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.chatId] - for tool-progress events
   * @param {string} [options.language]
   * @param {number} [options.count] - results to return (max {@link SEARXNG_MAX_WEB_RESULTS})
   * @param {string} [options.timeRange] - `day` | `week` | `month` | `year` (mapped by {@link searxngTimeRange})
   * @param {number} [options.safesearch] - 0 off, 1 moderate, 2 strict
   * @param {boolean} [options.skipCache] - always issue a request (the admin test)
   * @param {Object} [options.settings] - settings to use instead of the
   *   installation's (the admin test of unsaved values; always with `skipCache`)
   * @returns {Promise<{results: Array<Object>}>}
   */
  async search(query, options = {}) {
    const {
      chatId,
      language,
      count = SEARXNG_DEFAULT_RESULTS,
      timeRange,
      safesearch = 1,
      skipCache = false
    } = options;

    const settings = options.settings || this.settingsResolver();
    if (!settings.baseUrl) {
      const error = new Error(
        'The SearXNG instance URL is not configured. Enter it in the SearXNG integration (Admin → Integrations).'
      );
      error.code = 'SEARXNG_NOT_CONFIGURED';
      throw error;
    }

    const lang = resolveSearxngLanguage(this.languageResolver(language));
    const wanted = clampCount(count);
    const safe = clampSafesearch(safesearch);
    const range = searxngTimeRange(timeRange);

    if (chatId) {
      emitToolProgress(chatId, {
        phase: 'search',
        message: query,
        data: { query, provider: 'searxng' }
      });
    }

    // The instance is part of the key: two installations (or an edited URL)
    // must not share answers.
    const cacheKey = makeSearchCacheKey('searxng', query, {
      instance: settings.baseUrl,
      language: lang || '',
      timeRange: range || '',
      count: wanted,
      safesearch: safe
    });
    if (!skipCache) {
      const cached = getCachedSearch(cacheKey);
      if (cached) {
        logger.debug('SearXNG search cache hit', { component: 'WebSearch', provider: 'searxng' });
        return cached;
      }
    }

    const url = buildSearxngSearchUrl({
      baseUrl: settings.baseUrl,
      query,
      language: lang,
      timeRange: range,
      safesearch: safe
    });

    const MAX_RETRIES = 2;
    let attempt = 0;

    while (true) {
      const res = await this.fetchOnce(url, settings);
      const payload = await readJsonBody(res);
      const error = parseSearxngError(payload, res.status, res.headers?.get?.('location'));

      if (!error) {
        const result = { results: parseSearxngResults(payload).slice(0, wanted) };
        const parsedTtl = Number(config.SEARCH_CACHE_TTL_MS);
        const ttlMs = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 600000;
        setCachedSearch(cacheKey, result, ttlMs);
        return result;
      }

      // Only throttling is transient. A 403 (JSON disabled), a 404 or a
      // rejected credential is a property of the instance, not of this try.
      const retryable = error.code === 'SEARXNG_RATE_LIMITED' || res.status === 503;
      if (retryable && attempt < MAX_RETRIES) {
        await waitBeforeRetry({
          res,
          attempt,
          backoffMs: this.retryBackoffMs,
          provider: 'searxng',
          label: 'SearXNG'
        });
        attempt += 1;
        continue;
      }

      throw searchFailure({ error, res, provider: 'searxng', label: 'SearXNG' });
    }
  }

  /**
   * One request, with the network layer's failures wrapped so a proxy, TLS or
   * DNS problem is diagnosable instead of surfacing as a bare "fetch failed".
   * @param {string} url
   * @param {{ baseUrl: string, authorization?: string }} settings
   * @returns {Promise<Object>} the fetch Response
   */
  async fetchOnce(url, settings) {
    const headers = { Accept: 'application/json', 'User-Agent': SEARXNG_USER_AGENT };
    if (settings.authorization) headers.Authorization = settings.authorization;
    // A refusal is the answer, not a network failure: it is thrown as it is.
    const { lookup } = await this.targetGuard(settings.baseUrl);
    try {
      return await this.fetchImpl(url, {
        headers,
        redirect: 'manual',
        ...(lookup ? { lookup } : {})
      });
    } catch (error) {
      throw networkFailure({
        error,
        provider: 'searxng',
        label: 'SearXNG',
        details: { instance: settings.baseUrl },
        hint: SELF_HOSTED_HINT
      });
    }
  }
}

export { SearxngSearchProvider };
export default SearxngSearchProvider;
