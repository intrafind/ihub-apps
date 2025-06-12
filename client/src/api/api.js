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

// Enhanced retry mechanism for failed requests
apiClient.interceptors.response.use(null, async (error) => {
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
});

// Handle API responses and errors consistently
const handleApiResponse = async (apiCall, cacheKey = null, ttl = DEFAULT_CACHE_TTL.MEDIUM, deduplicate = true) => {
  try {
    // Check cache first if cacheKey is provided
    if (cacheKey) {
      const cachedData = cache.get(cacheKey);
      if (cachedData) {
        console.log(`Cache hit for: ${cacheKey}`);
        return cachedData;
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
        const data = response.data;
        
        // Cache the response if cacheKey is provided
        if (cacheKey && data) {
          cache.set(cacheKey, data, ttl);
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
          const errorPlaceholder = { error: enhancedError.message, isErrorPlaceholder: true };
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

// Chat - no caching for chat operations as they're dynamic
export const streamAppChat = async (appId, chatId) => {
  return new EventSource(`${API_URL}/apps/${appId}/chat/${chatId}`);
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
  // Ensure the last message in the array includes the messageId if available
  if (messages && messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    
    // Log the messageId if it's being sent through
    if (lastMessage && lastMessage.messageId) {
      console.log(`Sending message with ID: ${lastMessage.messageId}`);
    } else {
      console.warn('No messageId found in the last message');
    }
  }

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


export const sendDirectModelMessage = async (modelId, messages, options = {}) => {
  return handleApiResponse(() =>
    apiClient.post(`/models/${modelId}/chat`, {
      messages,
      ...options
    }),
    null, // No caching for chat messages
    null,
    false // Don't deduplicate chat requests
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

// Advanced cache operations
export const prefetchData = async () => {
  try {
    console.log('Prefetching common data...');
    // Fetch common data in parallel
    
    // Get current language from localStorage and normalize it
    const rawLanguage = localStorage.getItem('i18nextLng') || 'en';
    const currentLanguage = rawLanguage.split('-')[0].toLowerCase();
    
    await Promise.all([
      fetchUIConfig(),
      fetchStyles(),
      fetchModels(),
      fetchApps(),
      fetchTranslations(currentLanguage)
    ]);
    console.log('Prefetch completed successfully');
    return true;
  } catch (error) {
    console.error('Prefetch failed:', error);
    return false;
  }
};

// Request timeout detection
export const isTimeoutError = (error) => {
  return error?.message?.includes('timeout') || 
    error?.originalError?.message?.includes('timeout') || 
    error?.code === 'ECONNABORTED';
};

// Force refresh data from server
export const forceRefresh = async (type, id = null) => {
  let cacheKey;
  let fetchFunction;
  let options = { skipCache: true };
  
  switch (type) {
    case 'app':
      if (!id) throw new Error('App ID is required for refreshing app details');
      cacheKey = buildCacheKey(CACHE_KEYS.APP_DETAILS, { id });
      fetchFunction = () => fetchAppDetails(id, options);
      break;
    case 'apps':
      cacheKey = CACHE_KEYS.APPS_LIST;
      fetchFunction = () => fetchApps(options);
      break;
    case 'model':
      if (!id) throw new Error('Model ID is required for refreshing model details');
      cacheKey = buildCacheKey(CACHE_KEYS.MODEL_DETAILS, { id });
      fetchFunction = () => fetchModelDetails(id, options);
      break;
    case 'models':
      cacheKey = CACHE_KEYS.MODELS_LIST;
      fetchFunction = () => fetchModels(options);
      break;
    case 'ui':
      cacheKey = CACHE_KEYS.UI_CONFIG;
      fetchFunction = () => fetchUIConfig(options);
      break;
    case 'styles':
      cacheKey = CACHE_KEYS.STYLES;
      fetchFunction = () => fetchStyles(options);
      break;
    default:
      throw new Error(`Unknown refresh type: ${type}`);
  }
  
  // First clear the cache
  cache.delete(cacheKey);
  
  // Then fetch fresh data
  const freshData = await fetchFunction();
  
  // Update the cache with fresh data
  cache.set(cacheKey, freshData);
  
  return freshData;
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

// Centralized API service with consistent use of apiClient
const apiService = {
  /**
   * Get UI configuration settings
   * @returns {Promise} Promise resolving to UI config data
   */
  getUIConfig: async () => {
    return fetchUIConfig();
  },

  /**
   * Get available applications
   * @returns {Promise} Promise resolving to apps data
   */
  getApps: async () => {
    return fetchApps();
  },
  
  /**
   * Get available models
   * @returns {Promise} Promise resolving to models data
   */
  getModels: async () => {
    return fetchModels();
  },
  
  /**
   * Log session start
   * @param {Object} sessionData - Session data to log
   * @returns {Promise} Promise resolving to response data
   */
  logSessionStart: async (sessionData) => {
    return handleApiResponse(
      () => apiClient.post('/session/start', sessionData),
      null, // No caching
      null,
      false // Don't deduplicate
    );
  },
  
  /**
   * Send a chat message
   * @param {string} endpoint - API endpoint for the specific chat
   * @param {Object} messageData - Message data to send
   * @returns {Promise} Promise resolving to response data
   */
  sendChatMessage: async (endpoint, messageData) => {
    return handleApiResponse(
      () => apiClient.post(endpoint, messageData),
      null, // No caching for chat messages
      null,
      false // Don't deduplicate chat requests
    );
  },

  // Reuse the exported functions for consistency
  fetchPageContent,
  fetchApps,
  fetchAppDetails,
  fetchModels,
  fetchModelDetails,
  fetchStyles,
  fetchUIConfig,
  fetchTranslations,
  sendAppChatMessage,
  sendDirectModelMessage,
  generateMagicPrompt,
  sendMessageFeedback
};

export default apiService;