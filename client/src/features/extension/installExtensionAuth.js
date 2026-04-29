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
import { setApiBaseUrlOverride } from '../../utils/runtimeBasePath';

/**
 * @param {{ baseUrl: string, clientId: string, redirectUri: string }} config
 */
export function installExtensionAuth(config) {
  // Re-target both Axios clients at the iHub server. In the main web app
  // and in the Outlook taskpane these defaults are computed from
  // window.location.origin (via runtimeBasePath), but here that origin is
  // chrome-extension://<id>, which obviously does not host the iHub API.
  const baseUrl = String(config.baseUrl).replace(/\/$/, '');
  const apiBase = `${baseUrl}/api`;
  apiClient.defaults.baseURL = apiBase;
  streamingApiClient.defaults.baseURL = apiBase;

  // The chat hook (and a few other call sites) build SSE / fetch URLs via
  // `buildApiUrl()` which resolves relative to window.location. From a
  // chrome-extension:// origin that produces chrome-extension://<id>/api/...
  // — wrong host. Tell runtimeBasePath to emit absolute iHub URLs from
  // here on, so EventSource and any other relative-URL consumer reaches
  // the iHub server instead of the extension's own origin.
  setApiBaseUrlOverride(baseUrl);

  // Bearer token + 401-refresh interceptors. The same module the Outlook
  // taskpane uses — the only host-specific piece is the baseURL above and
  // the auth dialog (handled in the host adapter, not here).
  installOfficeAuthInterceptor(config);
}
