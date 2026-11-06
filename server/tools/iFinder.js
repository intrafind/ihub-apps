// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import iFinderService from '../services/integrations/iFinderService.js';
import iFinderScopes, {
  resolveToolSearchProfile,
  searchProfileNames
} from '../services/integrations/scopes/iFinderScopes.js';

/**
 * The call's params with the search profile it may search in: the chat's
 * scope when the user picked one (it wins over the model's `searchProfile`),
 * otherwise the model's choice once it passed the allow-list and the user's
 * own profiles (#3050).
 */
async function withSearchProfile(params = {}) {
  return (await resolveScopedParams(params)).scoped;
}

/** {@link withSearchProfile}, plus whether the chat fixed the profile. */
async function resolveScopedParams(params = {}) {
  const { searchProfile, fixed } = await resolveToolSearchProfile(params);
  return { scoped: { ...params, searchProfile }, fixed: Boolean(fixed) };
}

/**
 * Run a call that reports documents, and add the display name of the search
 * profile it ran in (`searchProfileName`), which the sources panel shows on
 * every document it found (#3056). The name comes from the user's cached
 * profile list and is read beside the call, so it adds no wait; when it is
 * unknown the result stays as it was and the panel shows the id.
 *
 * @param {Object} params - the tool call's params
 * @param {(params: Object, scope: {fixed: boolean}) => Promise<Object>} run - the
 *   service call, given the scoped params and whether the chat fixed the profile
 * @returns {Promise<Object>} the call's result
 */
async function withSearchProfileName(params, run) {
  const { scoped, fixed } = await resolveScopedParams(params);
  const [result, names] = await Promise.all([
    run(scoped, { fixed }),
    searchProfileNames({ user: scoped.user, signal: scoped.signal })
  ]);
  const searchProfile = result && typeof result === 'object' ? result.searchProfile : undefined;
  const name = typeof searchProfile === 'string' ? names.get(searchProfile) : undefined;
  return name && !result.error ? { ...result, searchProfileName: name } : result;
}

/** True when a query string matches every document (`*`, `*:*`) or is empty. */
function matchesEverything(query) {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  return trimmed === '' || trimmed === '*' || trimmed === '*:*';
}

/**
 * What the model should do next after a search that found nothing.
 *
 * iFinder's search profiles combine bare query words with OR and
 * `minimum_should_match: 3<-25%`: every word of a query of up to three words
 * must match, and from four on a quarter may miss. So a short query that
 * matched nothing cannot match anything with one more word, and padding it to
 * four words or more only finds documents that lack one of the original words.
 * Yet that is the retry models reach for ("vacation policy" → "vacation policy
 * company"). The hint says so at the moment the model decides, and names the
 * moves that do widen: fewer words, other words, and an explicit OR, which
 * `minimum_should_match` does not apply to. It does not suggest another
 * search profile when the chat fixed the profile.
 *
 * @param {Object} params - the search call's params (`query`, `filter`)
 * @param {{fixed?: boolean}} [scope] - whether the chat fixed the profile
 * @returns {string} the hint
 */
export function zeroHitHint({ query, filter } = {}, { fixed = false } = {}) {
  const filters = Array.isArray(filter) ? filter.filter(Boolean) : [];
  const steps = [];
  if (matchesEverything(query)) {
    steps.push(
      'The query matches every document, so a filter excluded them all: check each filter value against iFinder_getFacetValues and the field name against iFinder_getFields, or drop filters one at a time.'
    );
  } else {
    steps.push(
      'No document matched. Do not retry with the same words plus more: up to three words must all match, so one more word cannot find anything, and from four words on one word may miss, so the hits lack one of your words and drift off topic.',
      'Widen instead: keep only the one or two words that carry the topic; swap words for synonyms, a broader term or the other language (German/English); join alternatives with an explicit OR (`urlaub OR ferien OR abwesenheit`), which matches any one of them; or use `THES/&term` for thesaurus expansion or a prefix wildcard (`urlaub*`).'
    );
    if (filters.length > 0) {
      steps.push(
        'The filters are ANDed with the query: run it once without them to see whether a filter is what excludes the hits.'
      );
    }
  }
  if (!fixed) {
    steps.push(
      'If a broader query also finds nothing, check the search profile with iFinder_listProfiles.'
    );
  }
  steps.push('Only report that no document exists after a broader query also found nothing.');
  return steps.join(' ');
}

/**
 * Search for documents in iFinder
 * @param {Object} params - The search parameters
 * @param {string} params.query - The search query
 * @param {number} [params.limit] - Maximum number of results to return
 * @returns {Promise<Object>} The search results, with `searchProfileName` when
 *   known and a `hint` when nothing matched ({@link zeroHitHint})
 */
export async function search(params) {
  return withSearchProfileName(params, async (scoped, scope) => {
    const result = await iFinderService.search(scoped);
    if (result && typeof result === 'object' && !result.error && result.totalFound === 0) {
      return { ...result, hint: zeroHitHint(scoped, scope) };
    }
    return result;
  });
}

/**
 * Get document content by ID
 * @param {Object} params - The parameters
 * @param {string} params.documentId - The document ID
 * @returns {Promise<Object>} The document content, with `searchProfileName` when known
 */
export async function getContent(params) {
  return withSearchProfileName(params, scoped => iFinderService.getContent(scoped));
}

/**
 * Get document metadata by ID
 * @param {Object} params - The parameters
 * @param {string} params.documentId - The document ID
 * @returns {Promise<Object>} The document metadata, with `searchProfileName` when known
 */
export async function getMetadata(params) {
  return withSearchProfileName(params, scoped => iFinderService.getMetadata(scoped));
}

/**
 * Probe a search profile and produce a corpus map: totals, top facet values,
 * available filterable fields, and sample document titles. Used by agents and
 * workflows to learn what data is available before issuing a real search,
 * and by the admin "build memory from tool" endpoint to seed long-term memory.
 *
 * @param {Object} params
 * @returns {Promise<Object>} Discovery result including `markdown` field
 */
export async function discover(params) {
  return iFinderService.discover(await withSearchProfile(params));
}

/**
 * Fetch the index field catalog: every field with the exact name to use for
 * full-text search, filtering, faceting and sorting. This is the authoritative
 * answer to "does this field need `.keyword`?" for a given deployment.
 *
 * @param {Object} params
 * @returns {Promise<Object>} Field catalog
 */
export async function getFields(params) {
  return iFinderService.getFields(params);
}

/**
 * Enumerate the values of one facet (source, author, language, ...) far beyond
 * the capped facet block that rides along with a search response.
 *
 * @param {Object} params
 * @param {string} params.facet - Aggregatable field name, e.g. `creators.keyword`
 * @returns {Promise<Object>} Facet values with counts
 */
export async function getFacetValues(params) {
  return iFinderService.getFacetValues(await withSearchProfile(params));
}

/**
 * List the search profiles the calling user may search with, as iFinder's
 * searchbar offers them, plus the configured default.
 *
 * @param {Object} params
 * @returns {Promise<Object>} The profiles and the configured default
 */
export async function listProfiles(params) {
  const { searchProfile, fixed } = await resolveToolSearchProfile({
    ...params,
    searchProfile: undefined
  });
  if (!fixed) return iFinderService.listProfiles(params);
  // The chat searches one profile; there is nothing to switch to.
  const { scopes } = await iFinderScopes.listScopes({ user: params.user, app: params.appConfig });
  const name = scopes.find(scope => scope.id === searchProfile)?.name || searchProfile;
  return {
    defaultSearchProfile: searchProfile,
    profiles: [{ id: searchProfile, name, isDefault: true }],
    fixed: true,
    note: 'The search profile is fixed for this chat. Every iFinder call searches it; do not pass another searchProfile.'
  };
}

// Export default with all methods
export default {
  search,
  getContent,
  getMetadata,
  discover,
  getFields,
  getFacetValues,
  listProfiles
};
