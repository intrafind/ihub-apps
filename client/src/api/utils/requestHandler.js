// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import cache, { DEFAULT_CACHE_TTL } from '../../utils/cache';
import { API_REQUEST_TIMEOUT } from '../client';
import { enhanceApiError } from './apiErrors';

export { isTimeoutError } from './apiErrors';

// Keep track of pending requests for deduplication
const pendingRequests = new Map();

// Handle API responses with in-memory caching and optional ETag support
// Cache entries live only for the lifetime of the page. Data is kept in memory
// and not persisted to sessionStorage.
export const handleApiResponse = async (
  apiCall,
  cacheKey = null,
  ttl = DEFAULT_CACHE_TTL.MEDIUM,
  deduplicate = true,
  handleETag = false
) => {
  try {
    // Check cache first if cacheKey is provided
    if (cacheKey) {
      const cachedData = cache.get(cacheKey);
      if (cachedData && !handleETag) {
        console.log(`Cache hit for: ${cacheKey}`);
        // Support both old format (direct data) and new format (with data/etag)
        return cachedData.data !== undefined ? cachedData.data : cachedData;
      }
    }

    // Request deduplication - if we're already making this exact same request, reuse the promise
    // This prevents sending multiple identical requests simultaneously
    if (deduplicate && cacheKey) {
      const pendingRequest = pendingRequests.get(cacheKey);
      if (pendingRequest) {
        console.log(`Deduplicating request for: ${cacheKey}`);
        return pendingRequest;
      }
    }

    // Create a promise for the API call
    const requestPromise = (async () => {
      try {
        // Make the API call
        const response = await apiCall();

        // Handle 304 Not Modified response
        if (response.status === 304 || response.isNotModified) {
          console.log(`304 Not Modified for: ${cacheKey}`);
          const cachedData = cache.get(cacheKey);
          if (cachedData) {
            // Support both old format (direct data) and new format (with data/etag)
            return cachedData.data !== undefined ? cachedData.data : cachedData;
          }
          // If no cached data, this is an error condition
          throw new Error('304 Not Modified but no cached data available');
        }

        const data = response.data;

        // Cache the response if cacheKey is provided
        if (cacheKey && data) {
          const cacheEntry = { data, timestamp: Date.now() };

          // Store ETag if present
          if (handleETag && response.headers.etag) {
            cacheEntry.etag = response.headers.etag;
          }

          cache.set(cacheKey, cacheEntry, ttl);
        }

        return data;
      } catch (error) {
        const enhancedError = enhanceApiError(error);

        // Add request details to error for better debugging
        enhancedError.requestDetails = {
          url: error.config?.url,
          method: error.config?.method,
          timestamp: new Date().toISOString()
        };

        console.error(`API Error: ${enhancedError.originalMessage}`, {
          status: enhancedError.status,
          userFriendlyMessage: enhancedError.message,
          details: error.response?.data,
          url: error.config?.url
        });

        throw enhancedError;
      } finally {
        // Always clear the pending request reference when done
        if (cacheKey) {
          pendingRequests.delete(cacheKey);
        }
      }
    })();

    // Store the promise for deduplication
    if (deduplicate && cacheKey) {
      pendingRequests.set(cacheKey, requestPromise);

      // Set a timeout to remove the pending request if it takes too long
      setTimeout(() => {
        if (pendingRequests.get(cacheKey) === requestPromise) {
          pendingRequests.delete(cacheKey);
        }
      }, API_REQUEST_TIMEOUT + 1000); // Slightly longer than the actual timeout
    }

    return requestPromise;
  } catch (error) {
    console.error('Error in handleApiResponse wrapper:', error);
    throw error;
  }
};
