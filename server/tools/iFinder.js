// This wrapper is maintained for backward compatibility

import iFinderService from '../services/integrations/iFinderService.js';

/**
 * Search for documents in iFinder
 * @param {Object} params - The search parameters
 * @param {string} params.query - The search query
 * @param {number} [params.limit] - Maximum number of results to return
 * @returns {Promise<Object>} The search results
 */
export async function search(params) {
  return iFinderService.search(params);
}

/**
 * Get document content by ID
 * @param {Object} params - The parameters
 * @param {string} params.documentId - The document ID
 * @returns {Promise<Object>} The document content
 */
export async function getContent(params) {
  return iFinderService.getContent(params);
}

/**
 * Get document metadata by ID
 * @param {Object} params - The parameters
 * @param {string} params.documentId - The document ID
 * @returns {Promise<Object>} The document metadata
 */
export async function getMetadata(params) {
  return iFinderService.getMetadata(params);
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
  return iFinderService.discover(params);
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
  return iFinderService.getFacetValues(params);
}

/**
 * List the search profiles the calling user can reach, derived from the
 * iAssistants the public API exposes plus the configured default.
 *
 * @param {Object} params
 * @returns {Promise<Object>} Profiles and the iAssistants that reference them
 */
export async function listProfiles(params) {
  return iFinderService.listProfiles(params);
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
