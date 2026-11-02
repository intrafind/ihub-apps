// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// This wrapper is maintained for backward compatibility

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
  const { searchProfile } = await resolveToolSearchProfile(params);
  return { ...params, searchProfile };
}

/**
 * Run a call that reports documents, and add the display name of the search
 * profile it ran in (`searchProfileName`), which the sources panel shows on
 * every document it found (#3056). The name comes from the user's cached
 * profile list and is read beside the call, so it adds no wait; when it is
 * unknown the result stays as it was and the panel shows the id.
 *
 * @param {Object} params - the tool call's params
 * @param {(params: Object) => Promise<Object>} run - the service call
 * @returns {Promise<Object>} the call's result
 */
async function withSearchProfileName(params, run) {
  const scoped = await withSearchProfile(params);
  const [result, names] = await Promise.all([
    run(scoped),
    searchProfileNames({ user: scoped.user, signal: scoped.signal })
  ]);
  const searchProfile = result && typeof result === 'object' ? result.searchProfile : undefined;
  const name = typeof searchProfile === 'string' ? names.get(searchProfile) : undefined;
  return name && !result.error ? { ...result, searchProfileName: name } : result;
}

/**
 * Search for documents in iFinder
 * @param {Object} params - The search parameters
 * @param {string} params.query - The search query
 * @param {number} [params.limit] - Maximum number of results to return
 * @returns {Promise<Object>} The search results, with `searchProfileName` when known
 */
export async function search(params) {
  return withSearchProfileName(params, scoped => iFinderService.search(scoped));
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
