/**
 * Auth bridge for the iHub browser extension's React app.
 *
 * The extension's side panel runs from a chrome-extension:// origin, not
 * the iHub server origin, so the Axios clients need an explicit baseURL
 * pointed at the configured iHub instance. After that, the existing
 * Office interceptor logic (Bearer token from localStorage, silent
 * refresh on 401) works unchanged.
 */
import { apiClient, streamingApiClient } from '../../api/client';
import { installOfficeAuthInterceptor } from '../office/api/officeAuthBridge';

/**
 * @param {{ baseUrl: string, clientId: string, redirectUri: string }} config
 */
export function installExtensionAuth(config) {
  // Re-target both Axios clients at the iHub server. In the main web app
  // and in the Outlook taskpane these defaults are computed from
  // window.location.origin (via runtimeBasePath), but here that origin is
  // chrome-extension://<id>, which obviously does not host the iHub API.
  const apiBase = `${String(config.baseUrl).replace(/\/$/, '')}/api`;
  apiClient.defaults.baseURL = apiBase;
  streamingApiClient.defaults.baseURL = apiBase;

  // Bearer token + 401-refresh interceptors. The same module the Outlook
  // taskpane uses — the only host-specific piece is the baseURL above and
  // the auth dialog (handled in the host adapter, not here).
  installOfficeAuthInterceptor(config);
}
