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

// Export default with all methods
export default {
  search,
  getContent,
  getMetadata,
  discover
};
