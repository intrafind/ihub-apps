// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import cache, { CACHE_KEYS, DEFAULT_CACHE_TTL, buildCacheKey } from '../../utils/cache';

// Models. Chat models only, unless `withTranscription`: the chat's model
// selector also offers transcription models, which answer an audio or video
// file with its transcript.
export const fetchModels = async (options = {}) => {
  const { skipCache = false, withTranscription = false } = options;
  const type = withTranscription ? 'chat,transcription' : null;
  let cacheKey = null;
  if (!skipCache) {
    cacheKey = type ? buildCacheKey(CACHE_KEYS.MODELS_LIST, { type }) : CACHE_KEYS.MODELS_LIST;
  }

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

      return apiClient.get('/models', { headers, ...(type ? { params: { type } } : {}) });
    },
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM,
    true,
    true // Enable ETag handling
  );
};

// Fetch text-to-speech models (modelType: 'tts') this user may use, for read
// aloud. Same sanitized shape as the transcription list; not cached under the
// chat models key.
export const fetchTtsModels = async () => {
  return handleApiResponse(
    () => apiClient.get('/models', { params: { type: 'tts' } }),
    null,
    null,
    false
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

export const testModel = async modelId => {
  return handleApiResponse(
    () => apiClient.get(`/models/${modelId}/chat/test`),
    null, // No caching for test calls
    null,
    false // Don't deduplicate test requests
  );
};
