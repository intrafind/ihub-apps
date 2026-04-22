/**
 * Auth bridge for the Office add-in.
 *
 * Installs request and response interceptors on apiClient and streamingApiClient so that:
 * - Every outgoing request carries the Office Bearer token (Authorization header).
 * - 401 responses automatically attempt a silent token refresh and retry once.
 * - If the refresh fails, the session-expired callback is invoked (navigates to login).
 *
 * Call installOfficeAuthInterceptor(config) once from taskpane-entry.jsx after Office.onReady.
 * The config object ({ baseUrl, clientId, redirectUri }) is stored in officeAuth so that
 * the SSE hook and other modules can also call refreshTokenOrExpireSession() without
 * needing to thread the config through their call stacks.
 */
import { apiClient, streamingApiClient } from '../../../api/client';
import {
  OFFICE_TOKEN_KEY,
  getAccessToken,
  setOfficeConfig,
  refreshTokenOrExpireSession
} from './officeAuth';

/**
 * Installs auth interceptors on both Axios clients.
 *
 * Request interceptor:
 *   - Injects the Office access token as Authorization: Bearer <token>.
 *   - Tags each request with _isOfficeRequest = true so the main app's 401
 *     handler (which clears the wrong localStorage key and dispatches
 *     authTokenExpired) skips processing for Office requests.
 *   - Moved to index 0 of the internal handlers array so it executes last
 *     (Axios request interceptors run LIFO), overriding the main app's
 *     interceptor that would otherwise set the wrong token.
 *
 * Response interceptor:
 *   - Catches 401 errors for Office requests.
 *   - Attempts a silent token refresh via refreshTokenOrExpireSession().
 *   - Retries the original request once with the new token (_officeRetry flag
 *     prevents infinite loops).
 *   - If the refresh fails, the session-expired callback fires (navigates to
 *     login) and the error propagates.
 */
export function installOfficeAuthInterceptor(config) {
  // Store config so refreshTokenOrExpireSession() and the SSE hook can use it
  // without needing the config threaded through every call site.
  setOfficeConfig(config);

  const addInterceptor = client => {
    // --- Request interceptor ---
    client.interceptors.request.use(reqConfig => {
      const token = localStorage.getItem(OFFICE_TOKEN_KEY);
      if (token) {
        reqConfig.headers['Authorization'] = `Bearer ${token}`;
      }
      // Tag so the main app's response interceptor skips 401 handling for us.
      reqConfig._isOfficeRequest = true;
      return reqConfig;
    });

    // Move the just-added handler to index 0 so it executes last (Axios LIFO).
    const { handlers } = client.interceptors.request;
    if (Array.isArray(handlers) && handlers.length > 1) {
      const officeHandler = handlers.pop();
      handlers.unshift(officeHandler);
    }

    // --- Response interceptor ---
    client.interceptors.response.use(
      response => response,
      async error => {
        const originalRequest = error.config;

        // Only handle 401s for Office requests, and only attempt one refresh.
        if (
          error.response?.status === 401 &&
          originalRequest?._isOfficeRequest &&
          !originalRequest._officeRetry
        ) {
          originalRequest._officeRetry = true;

          try {
            await refreshTokenOrExpireSession();
          } catch {
            // Refresh failed — session-expired callback already invoked.
            return Promise.reject(error);
          }

          // Refresh succeeded — retry with the new token.
          const newToken = getAccessToken();
          if (newToken) {
            originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
          }
          return client(originalRequest);
        }

        return Promise.reject(error);
      }
    );
  };

  addInterceptor(apiClient);
  addInterceptor(streamingApiClient);
}
