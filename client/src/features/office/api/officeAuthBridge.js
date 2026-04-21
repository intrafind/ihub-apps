/**
 * Auth bridge for the Office add-in.
 *
 * Installs an Axios interceptor on apiClient and streamingApiClient that injects
 * the Office Bearer token into all requests. This allows the main app's API layer
 * (sendAppChatMessage, checkAppChatStatus, stopAppChatStream, fetchApps, etc.) to
 * work seamlessly within the Office taskpane without any changes to those functions.
 *
 * Call installOfficeAuthInterceptor() once from taskpane-entry.jsx after Office.onReady.
 */
import { apiClient, streamingApiClient } from '../../../api/client';
import { OFFICE_TOKEN_KEY } from './officeAuth';

/**
 * Installs a request interceptor on both apiClient and streamingApiClient that
 * reads the Office access token and sets the Authorization header.
 *
 * Axios request interceptors execute in LIFO order, so an interceptor registered
 * last runs first — meaning the pre-existing auth interceptor would overwrite ours.
 * To guarantee the Office token takes precedence, we move our handler to index 0
 * of the internal handlers array so it is unshifted first into the dispatch chain
 * and therefore executes last (after the existing interceptor).
 */
export function installOfficeAuthInterceptor() {
  const addInterceptor = client => {
    client.interceptors.request.use(config => {
      const token = localStorage.getItem(OFFICE_TOKEN_KEY);
      if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
      return config;
    });

    // Move the just-added handler to index 0 so it executes last (Axios LIFO).
    const { handlers } = client.interceptors.request;
    if (Array.isArray(handlers) && handlers.length > 1) {
      const officeHandler = handlers.pop();
      handlers.unshift(officeHandler);
    }
  };

  addInterceptor(apiClient);
  addInterceptor(streamingApiClient);
}
