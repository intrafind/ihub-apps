import webSearchService from '../../services/WebSearchService.js';
import webContentExtractor from '../webContentExtractor.js';
import logger from '../../utils/logger.js';

/**
 * Shared body of the script-backed web search tools (`braveSearch`,
 * `staanSearch`, `qwantSearch`): run a query through {@link webSearchService}
 * and, when asked, fetch and trim the pages behind the top results.
 *
 * The tools differ only in which provider they name and how they log, so the
 * result shape — and the summary the model reads — stays identical across
 * providers. That is what lets an app swap `websearch.provider` without the
 * model seeing a different contract.
 *
 * ## Result shape
 *
 * Every result is normalized to `{ title, url, description, hostname }` plus,
 * where the provider returned them, `publishedDate` (ISO 8601), `age`
 * (Brave's own label, e.g. "2 days ago"), `snippets` (extra excerpts) and
 * `favicon`. The chat's source cards are drawn from these fields
 * (`services/loop/webSources.js`).
 *
 * ## Filters
 *
 * `freshness` (`day` | `week` | `month` | `year`) and `includeDomains` work
 * with every provider: a provider that filters natively gets the parameter
 * (Brave `freshness`, Staan `include_domains`); for the others, domains become
 * `site:` operators in the query, and freshness drops the dated results that
 * are too old — undated ones are kept, and the result says so.
 *
 * @module tools/lib/searchWithExtraction
 */

/** Values of the `freshness` filter, with the window each one allows. */
export const FRESHNESS_WINDOWS_MS = Object.freeze({
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 31 * 24 * 60 * 60 * 1000,
  year: 366 * 24 * 60 * 60 * 1000
});

/**
 * How far ahead of now a result's date may be and still count as current: a
 * date without a time, from a time zone ahead of UTC, reads as up to 14 hours
 * in the future. Later than that, the date is wrong or the page is not out yet.
 */
const FUTURE_DATE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Most domains one search may be restricted to. */
export const MAX_INCLUDE_DOMAINS = 10;

/**
 * @param {unknown} value - `day` | `week` | `month` | `year` (any case), or anything else
 * @returns {'day'|'week'|'month'|'year'|null}
 */
export function normalizeFreshness(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(FRESHNESS_WINDOWS_MS, key) ? key : null;
}

/**
 * Domains to restrict a search to, as bare host names: accepts an array or a
 * comma-separated string, with or without scheme, `www.` or path.
 * @param {unknown} value
 * @returns {string[]} at most {@link MAX_INCLUDE_DOMAINS}, deduplicated
 */
export function normalizeDomains(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    let host = entry.trim().toLowerCase();
    if (!host) continue;
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^site:/, '');
    host = host.split(/[/?#]/)[0].replace(/^www\./, '');
    if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host)) continue;
    if (!out.includes(host)) out.push(host);
    if (out.length >= MAX_INCLUDE_DOMAINS) break;
  }
  return out;
}

/**
 * The query with `site:` operators for providers that cannot restrict
 * domains themselves: `query site:a.com`, or `query (site:a.com OR site:b.com)`.
 * @param {string} query
 * @param {string[]} domains - normalized
 * @returns {string}
 */
export function withSiteFilter(query, domains) {
  if (!domains.length) return query;
  const clause =
    domains.length === 1
      ? `site:${domains[0]}`
      : `(${domains.map(domain => `site:${domain}`).join(' OR ')})`;
  return `${query} ${clause}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * One provider result in the shared shape (see the module doc). Unknown
 * fields are dropped so a provider cannot leak its whole payload to the model.
 * @param {Object} item
 * @returns {Object|null} null when the result has no URL
 */
export function normalizeSearchResult(item) {
  if (!item || typeof item.url !== 'string' || !item.url) return null;
  const result = {
    title: typeof item.title === 'string' ? item.title : '',
    url: item.url,
    description: typeof item.description === 'string' ? item.description : '',
    hostname:
      typeof item.hostname === 'string' && item.hostname
        ? item.hostname.replace(/^www\./, '')
        : hostOf(item.url)
  };
  if (typeof item.publishedDate === 'string' && !Number.isNaN(Date.parse(item.publishedDate))) {
    result.publishedDate = item.publishedDate;
  }
  if (typeof item.age === 'string' && item.age) result.age = item.age;
  if (Array.isArray(item.snippets) && item.snippets.length) result.snippets = item.snippets;
  if (typeof item.favicon === 'string' && item.favicon) result.favicon = item.favicon;
  if (typeof item.language === 'string' && item.language) result.language = item.language;
  return result;
}

/**
 * Drop results whose date lies outside the freshness window (older than it,
 * or more than a day in the future); results without a date are kept
 * (nothing says they are old).
 * @param {Object[]} results - normalized
 * @param {'day'|'week'|'month'|'year'} freshness
 * @param {number} [now=Date.now()]
 * @returns {{results: Object[], dropped: number}}
 */
export function filterByFreshness(results, freshness, now = Date.now()) {
  const windowMs = FRESHNESS_WINDOWS_MS[freshness];
  if (!windowMs) return { results, dropped: 0 };
  const kept = results.filter(result => {
    const time = Date.parse(result.publishedDate || '');
    if (Number.isNaN(time)) return true;
    const age = now - time;
    return age >= -FUTURE_DATE_TOLERANCE_MS && age <= windowMs;
  });
  return { results: kept, dropped: results.length - kept.length };
}

/**
 * @param {Object} params
 * @param {string} params.query - Search terms (already resolved from `query`/`q`)
 * @param {string} params.provider - Provider id registered with the search service
 * @param {string} params.component - Component name used in log lines
 * @param {boolean} [params.extractContent=false] - Fetch page content for the results
 * @param {number} [params.maxResults=10] - Cap on results returned / pages extracted
 * @param {number} [params.contentMaxLength=3000] - Characters of content kept per page
 * @param {string} [params.freshness] - `day` | `week` | `month` | `year`
 * @param {string[]|string} [params.includeDomains] - Restrict results to these domains
 * @param {string} [params.chatId] - Chat id, for progress events
 * @param {Object} [params.searchOptions] - Extra provider options (e.g. `language`)
 * @returns {Promise<Object>} Search results, optionally with extracted page content
 */
export default async function searchWithExtraction({
  query,
  provider,
  component,
  extractContent = false,
  maxResults = 10,
  contentMaxLength = 3000,
  freshness,
  includeDomains,
  chatId,
  searchOptions = {}
}) {
  const searchProvider = webSearchService.getProvider(provider);
  const nativeFreshness = Boolean(searchProvider?.supportsFreshness?.());
  const nativeDomains = Boolean(searchProvider?.supportsDomainFilter?.());

  const age = normalizeFreshness(freshness);
  const domains = normalizeDomains(includeDomains ?? searchOptions.includeDomains);
  const providerQuery = nativeDomains ? query : withSiteFilter(query, domains);

  const rawResults = await webSearchService.search(providerQuery, {
    ...searchOptions,
    ...(nativeDomains && domains.length ? { includeDomains: domains } : {}),
    ...(nativeFreshness && age ? { freshness: age } : {}),
    provider,
    chatId
  });

  let normalized = (rawResults?.results || []).map(normalizeSearchResult).filter(Boolean);
  let note;
  if (age && !nativeFreshness) {
    const filtered = filterByFreshness(normalized, age);
    normalized = filtered.results;
    note =
      `This search engine cannot filter by date, so results dated outside the last ${age} ` +
      `were dropped (${filtered.dropped}) and results without a date were kept.`;
  }

  // Truncate to maxResults to honour the configured limit
  const results = normalized.slice(0, maxResults);
  const filters =
    age || domains.length
      ? {
          ...(age ? { freshness: age } : {}),
          ...(domains.length ? { includeDomains: domains } : {})
        }
      : undefined;
  const extras = {
    ...(filters ? { filters } : {}),
    ...(note ? { note } : {})
  };

  if (!extractContent) {
    return { query, results, ...extras };
  }

  // Content extraction: fetch page content for the top N results
  if (results.length === 0) {
    return {
      query,
      results: [],
      extractedContent: [],
      summary: 'No search results found.',
      ...extras
    };
  }

  const resultsToProcess = results;

  logger.info('Extracting content from search results', {
    component,
    count: resultsToProcess.length
  });

  const contentPromises = resultsToProcess.map(async result => {
    try {
      const content = await webContentExtractor({
        url: result.url,
        maxLength: contentMaxLength,
        language: searchOptions.language,
        chatId
      });
      return {
        ...result,
        extractedContent: content,
        contentExtracted: true,
        extractionError: null
      };
    } catch (error) {
      logger.warn('Failed to extract content from URL', {
        component,
        url: result.url,
        error
      });
      return {
        ...result,
        extractedContent: null,
        contentExtracted: false,
        extractionError: error.message
      };
    }
  });

  const settled = await Promise.allSettled(contentPromises);
  const extractedContent = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          ...resultsToProcess[i],
          extractedContent: null,
          contentExtracted: false,
          extractionError: r.reason?.message || 'Unknown error'
        }
  );

  const successCount = extractedContent.filter(r => r.contentExtracted).length;

  return {
    query,
    results,
    extractedContent,
    summary: `Found ${results.length} results for "${query}". Extracted content from ${successCount} of ${resultsToProcess.length} pages.`,
    stats: {
      totalSearchResults: results.length,
      processedResults: resultsToProcess.length,
      successfulExtractions: successCount,
      failedExtractions: extractedContent.length - successCount
    },
    ...extras
  };
}
