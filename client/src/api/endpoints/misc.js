import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { CACHE_KEYS, DEFAULT_CACHE_TTL, buildCacheKey } from '../../utils/cache';

// Styles
export const fetchStyles = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.STYLES;

  return handleApiResponse(() => apiClient.get('/styles'), cacheKey, DEFAULT_CACHE_TTL.LONG);
};

// Send message feedback (thumbs up/down with optional comments)
export const sendMessageFeedback = async feedbackData => {
  return handleApiResponse(
    () => apiClient.post('/feedback', feedbackData),
    null, // No caching for feedback
    null,
    false // Don't deduplicate feedback requests
  );
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
  const cacheKey = skipCache
    ? null
    : buildCacheKey(CACHE_KEYS.PAGE_CONTENT, { id: pageId, language });

  return handleApiResponse(
    () => apiClient.get(`/pages/${pageId}`, { params: { lang: language } }),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

// Short links
export const createShortLink = async data => {
  return handleApiResponse(() => apiClient.post('/shortlinks', data), null, null, false);
};

export const getShortLink = async code => {
  return handleApiResponse(() => apiClient.get(`/shortlinks/${code}`), null, null, false);
};

// Session management
export const sendSessionStart = async sessionData => {
  return handleApiResponse(
    () => apiClient.post('/session/start', sessionData),
    null, // No caching
    null,
    false // Don't deduplicate
  );
};

// Tools
export const fetchTools = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.TOOLS;

  return handleApiResponse(() => apiClient.get('/tools'), cacheKey, DEFAULT_CACHE_TTL.MEDIUM);
};
