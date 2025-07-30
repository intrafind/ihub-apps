// This wrapper is maintained for backward compatibility

import iFinderService from '../services/integrations/iFinderService.js';

// Re-export all methods from the service
export async function search(params) {
  return iFinderService.search(params);
}

export async function getContent(params) {
  return iFinderService.getContent(params);
}

export async function getMetadata(params) {
  return iFinderService.getMetadata(params);
}

// Export default with all methods
export default {
  search,
  getContent,
  getMetadata
};
