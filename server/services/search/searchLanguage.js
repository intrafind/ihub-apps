/**
 * The language a web search should run in.
 *
 * Every search provider needs to answer the same question — *which language and
 * region do I search in?* — and before this module each one answered it with
 * its own hard-coded constant: `en_US` in Qwant, `en-us` in Staan, and nothing
 * at all in Brave. On a German install that meant a user typing German
 * questions could still get US-market results, and there was no setting
 * anywhere that changed it.
 *
 * So the order is fixed here, once, for all providers:
 *
 *  1. **The user's language**, as resolved for the request — the app/chat
 *     language, which itself comes from the client's explicit choice, then the
 *     `Accept-Language` header (see `routes/chat/sessionRoutes.js`).
 *  2. **`defaultLanguage` from `platform.json`**, the install-wide default the
 *     rest of the platform already uses for localization.
 *  3. `"en"`, only if the platform config cannot be read at all.
 *
 * Providers then map that one language onto whatever their own API wants —
 * Qwant's `xx_XX` locale, Staan's `xx-xx` market, Brave's `search_lang` +
 * `country` — and fall back to their own default only when the API does not
 * serve the requested language at all.
 *
 * Holding functions only (no module-scope work) keeps this safe to import from
 * either side of the `configCache → toolLoader → WebSearchService → provider`
 * cycle, for the same reason `braveApiKey.js` is split out.
 *
 * @module services/search/searchLanguage
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

/** Used only when the platform config cannot be read. */
export const FALLBACK_SEARCH_LANGUAGE = 'en';

/**
 * The install-wide default language, from `platform.json`.
 *
 * A search is never worth failing over a config read, so anything unreadable
 * degrades to {@link FALLBACK_SEARCH_LANGUAGE} rather than throwing.
 *
 * @returns {string} A language tag, e.g. `"en"` or `"de"`
 */
export function getPlatformDefaultLanguage() {
  try {
    const platform = configCache.getPlatform();
    const language = platform?.defaultLanguage;
    if (typeof language === 'string' && language.trim()) return language.trim();
  } catch (error) {
    logger.debug('Could not read platform defaultLanguage for web search', {
      component: 'WebSearch',
      error: error?.message
    });
  }
  return FALLBACK_SEARCH_LANGUAGE;
}

/**
 * Resolve the language a search should run in.
 *
 * @param {string} [language] - The user's language for this request, when known
 * @param {Object} [deps]
 * @param {() => string} [deps.defaultLanguage] - Install default, injected by
 *   tests so the fallback can be exercised without a populated config cache.
 * @returns {string} The language to search in — never empty
 */
export function resolveSearchLanguage(
  language,
  { defaultLanguage = getPlatformDefaultLanguage } = {}
) {
  if (typeof language === 'string' && language.trim()) return language.trim();
  const fallback = defaultLanguage();
  return typeof fallback === 'string' && fallback.trim()
    ? fallback.trim()
    : FALLBACK_SEARCH_LANGUAGE;
}
