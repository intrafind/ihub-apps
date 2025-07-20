import cache, { DEFAULT_CACHE_TTL } from '../../utils/cache';
import { API_REQUEST_TIMEOUT } from '../client';

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
        // Create user-friendly error messages
        let userMessage =
          error.response?.data?.error || error.message || 'An unexpected error occurred';
        let userFriendlyMessage = userMessage;

        // Handle specific error types with better messages
        if (error.response?.status === 403) {
          userFriendlyMessage =
            'You do not have permission to access this resource. Please contact your administrator if you believe this is an error.';
        } else if (error.response?.status === 401) {
          userFriendlyMessage = 'Please log in to access this resource.';
        } else if (error.response?.status === 404) {
          userFriendlyMessage = 'The requested resource was not found.';
        } else if (error.response?.status >= 500) {
          userFriendlyMessage = 'A server error occurred. Please try again later.';
        }

        // Enhance error object with useful information
        const enhancedError = new Error(userFriendlyMessage);
        enhancedError.status = error.response?.status || 500;
        enhancedError.originalError = error;
        enhancedError.originalMessage = userMessage;
        enhancedError.isAccessDenied = error.response?.status === 403;
        enhancedError.isAuthRequired = error.response?.status === 401;

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

        // For 5xx server errors, store a minimal placeholder in cache with shorter TTL
        // to prevent overwhelming the server with retries on error
        if (error.response?.status >= 500 && cacheKey) {
          const errorPlaceholder = {
            error: enhancedError.message,
            isErrorPlaceholder: true,
            status: enhancedError.status
          };
          cache.set(cacheKey, errorPlaceholder, DEFAULT_CACHE_TTL.SHORT);
        }

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

// Request timeout detection
export const isTimeoutError = error => {
  return (
    error?.message?.includes('timeout') ||
    error?.originalError?.message?.includes('timeout') ||
    error?.code === 'ECONNABORTED'
  );
};
