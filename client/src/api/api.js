import axios from 'axios';
import cache, { DEFAULT_CACHE_TTL, CACHE_KEYS, buildCacheKey } from '../utils/cache';
import { getSessionId, shouldRenewSession, renewSession } from '../utils/sessionManager';

// When using Vite's proxy feature, we should use a relative URL for development
// The direct URL (like http://localhost:3000/api) should only be used when not using the proxy
// or in production environments
const API_URL = import.meta.env.VITE_API_URL || '/api';
const API_REQUEST_TIMEOUT = 30000; // 30 seconds timeout

// Create axios instance with request timeout
const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: API_REQUEST_TIMEOUT
});

// Add request interceptor to include session ID header
apiClient.interceptors.request.use(config => {
  // Get session ID (creates a new one if needed)
  const sessionId = getSessionId();
  
  // Renew session if it's close to expiry
  if (shouldRenewSession()) {
    renewSession();
  }
  
  // Add session ID to request headers
  config.headers['X-Session-ID'] = sessionId;
  
  return config;
});

// Keep track of pending requests for deduplication
const pendingRequests = new Map();

// Enhanced retry mechanism for failed requests and 304 handling
apiClient.interceptors.response.use(
  (response) => {
    // Handle 304 Not Modified responses properly
    if (response.status === 304) {
      response.isNotModified = true;
    }
    return response;
  },
  async (error) => {
    const originalRequest = error.config;
    
    // Only retry GET requests, and only once
    if (originalRequest.method === 'get' && !originalRequest._retry && !error.response) {
      originalRequest._retry = true;
      console.log('Network error, retrying request once:', originalRequest.url);
      
      // Wait a moment before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
      return apiClient(originalRequest);
    }
    
    return Promise.reject(error);
  }
);

// Handle API responses and errors consistently
const handleApiResponse = async (apiCall, cacheKey = null, ttl = DEFAULT_CACHE_TTL.MEDIUM, deduplicate = true, handleETag = false) => {
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
        // Enhance error object with useful information
        const enhancedError = new Error(
          error.response?.data?.error || error.message || 'An unexpected error occurred'
        );
        enhancedError.status = error.response?.status || 500;
        enhancedError.originalError = error;
        
        // Add request details to error for better debugging
        enhancedError.requestDetails = {
          url: error.config?.url,
          method: error.config?.method,
          timestamp: new Date().toISOString()
        };
        
        console.error(`API Error: ${enhancedError.message}`, { 
          status: enhancedError.status,
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

// Apps
export const fetchApps = async (options = {}) => {
  const { skipCache = false, language = null } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.APPS_LIST, { language });
  
  return handleApiResponse(
    () => apiClient.get('/apps', { params: { language } }),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

export const fetchAppDetails = async (appId, options = {}) => {
  const { skipCache = false, language = null } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.APP_DETAILS, { id: appId, language });
  
  return handleApiResponse(
    () => apiClient.get(`/apps/${appId}`, { params: { language } }),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

// Models
export const fetchModels = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.MODELS_LIST;
  
  return handleApiResponse(
    () => apiClient.get('/models'),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

export const fetchModelDetails = async (modelId, options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.MODEL_DETAILS, { id: modelId });
  
  return handleApiResponse(
    () => apiClient.get(`/models/${modelId}`),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

/**
 * Sends a chat message to an app
 * 
 * @param {string} appId - The ID of the app to chat with
 * @param {string} chatId - The ID of the chat session
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Additional options
 * @returns {Promise<Response>} - Response from the API
 */
export const sendAppChatMessage = async (appId, chatId, messages, options = {}) => {

  if (!appId || !chatId || !messages) {
    throw new Error('Missing required parameters');
  }
  
  // Using apiClient instead of direct fetch
  return handleApiResponse(() => 
    apiClient.post(`/apps/${appId}/chat/${chatId}`, {
      messages,
      ...options
    }),
    null, // No caching for chat messages
    null,
    false // Don't deduplicate chat requests
  );
};

// Send message feedback (thumbs up/down with optional comments)
export const sendMessageFeedback = async (feedbackData) => {
  return handleApiResponse(() => 
    apiClient.post('/feedback', feedbackData),
    null, // No caching for feedback
    null,
    false // Don't deduplicate feedback requests
  );
};

// Admin usage data
export const fetchUsageData = async () => {
  return handleApiResponse(
    () => apiClient.get('/admin/usage'),
    null,
    null,
    false
  );
};

export const generateMagicPrompt = async (input, options = {}) => {
  return handleApiResponse(
    () => apiClient.post('/magic-prompt', { input, ...options }),
    null,
    null,
    false
  );
};

// Styles
export const fetchStyles = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.STYLES;

  return handleApiResponse(
    () => apiClient.get('/styles'),
    cacheKey,
    DEFAULT_CACHE_TTL.LONG
  );
};

// Prompts
export const fetchPrompts = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.PROMPTS;

  return handleApiResponse(
    () => {
      const headers = {};
      
      // Add ETag header if we have cached data
      if (cacheKey) {
        const cachedData = cache.get(cacheKey);
        if (cachedData && cachedData.etag) {
          headers['If-None-Match'] = cachedData.etag;
        }
      }
      
      return apiClient.get('/prompts', { headers });
    },
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM,
    true,
    true // Enable ETag handling
  );
};

// UI Configuration
export const fetchUIConfig = async (options = {}) => {
  const { skipCache = false, language = null } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.UI_CONFIG, { language });

  return handleApiResponse(
    () => apiClient.get('/ui', { params: { language } }),
    cacheKey,
    DEFAULT_CACHE_TTL.LONG
  );
};

// Platform configuration
export const fetchPlatformConfig = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.PLATFORM_CONFIG;

  return handleApiResponse(
    () => apiClient.get('/platform'),
    cacheKey,
    DEFAULT_CACHE_TTL.LONG
  );
};

// Test model
export const testModel = async (modelId) => {
  return handleApiResponse(() => 
    apiClient.get(`/models/${modelId}/chat/test`),
    null, // No caching for test calls
    null,
    false // Don't deduplicate test requests
  );
};

// Stop an ongoing streaming chat session
export const stopAppChatStream = async (appId, chatId) => {
  return handleApiResponse(() => 
    apiClient.post(`/apps/${appId}/chat/${chatId}/stop`),
    null, // No caching
    null,
    false // Don't deduplicate
  );
};

// Check if a chat session is still active
export const checkAppChatStatus = async (appId, chatId) => {
  return handleApiResponse(() => 
    apiClient.get(`/apps/${appId}/chat/${chatId}/status`),
    null, // Don't cache status checks
    null,
    false // Don't deduplicate status checks
  );
};

// Clear the API cache - useful when user actions might invalidate the cache
export const clearApiCache = (key = null) => {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
  console.log(key ? `Cleared cache for ${key}` : 'Cleared entire API cache');
};

// Invalidate specific cache entries based on prefix or pattern
export const invalidateCacheByPattern = (pattern) => {
  const invalidatedCount = cache.invalidateByPattern(pattern);
  console.log(`Invalidated ${invalidatedCount} cache entries matching: ${pattern}`);
  return invalidatedCount;
};

// Request timeout detection
export const isTimeoutError = (error) => {
  return error?.message?.includes('timeout') || 
    error?.originalError?.message?.includes('timeout') || 
    error?.code === 'ECONNABORTED';
};

// Translations
export const fetchTranslations = async (language, options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.TRANSLATIONS, { language });
  
  return handleApiResponse(
    () => apiClient.get(`/translations/${language}`),
    cacheKey,
    DEFAULT_CACHE_TTL.LONG
  );
};

// Pages
export const fetchPageContent = async (pageId, options = {}) => {
  const { skipCache = false, language = null } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.PAGE_CONTENT, { id: pageId, language });
  
  return handleApiResponse(
    () => apiClient.get(`/pages/${pageId}`, { params: { lang: language } }),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

// Short links
export const createShortLink = async (data) => {
  return handleApiResponse(() => apiClient.post('/shortlinks', data), null, null, false);
};

export const getShortLink = async (code) => {
  return handleApiResponse(() => apiClient.get(`/shortlinks/${code}`), null, null, false);
};

// Session management
export const sendSessionStart = async (sessionData) => {
  return handleApiResponse(
    () => apiClient.post('/session/start', sessionData),
    null, // No caching
    null,
    false // Don't deduplicate
  );
};

// Admin API functions
export const fetchAdminPrompts = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : 'admin_prompts';

  return handleApiResponse(
    () => {
      const headers = {};
      
      // Add ETag header if we have cached data
      if (cacheKey) {
        const cachedData = cache.get(cacheKey);
        if (cachedData && cachedData.etag) {
          headers['If-None-Match'] = cachedData.etag;
        }
      }
      
      return apiClient.get('/admin/prompts', { headers });
    },
    cacheKey,
    DEFAULT_CACHE_TTL.SHORT, // Shorter TTL for admin data
    true,
    true // Enable ETag handling
  );
};

export const createPrompt = async (promptData) => {
  return handleApiResponse(
    () => apiClient.post('/admin/prompts', promptData),
    null,
    null,
    false
  );
};

export const updatePrompt = async (promptId, promptData) => {
  return handleApiResponse(
    () => apiClient.put(`/admin/prompts/${promptId}`, promptData),
    null,
    null,
    false
  );
};

export const deletePrompt = async (promptId) => {
  return handleApiResponse(
    () => apiClient.delete(`/admin/prompts/${promptId}`),
    null,
    null,
    false
  );
};

export const togglePrompt = async (promptId) => {
  return handleApiResponse(
    () => apiClient.post(`/admin/prompts/${promptId}/toggle`),
    null,
    null,
    false
  );
};

export const fetchAdminApps = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : 'admin_apps';

  return handleApiResponse(
    () => apiClient.get('/admin/apps'),
    cacheKey,
    DEFAULT_CACHE_TTL.SHORT
  );
};

