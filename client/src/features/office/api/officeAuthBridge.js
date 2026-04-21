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
 * The interceptor runs after the existing one (which handles authToken / session IDs),
 * so it takes precedence when the Office token is present.
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
  };

  addInterceptor(apiClient);
  addInterceptor(streamingApiClient);
}
