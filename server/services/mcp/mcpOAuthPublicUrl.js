/**
 * The public identity iHub presents to an outbound authorization server:
 * the base URL, the OAuth callback, the Client ID Metadata Document (CIMD)
 * and the "Connect" path the chat and Settings send users to.
 *
 * One helper decides the public base so the redirect URI, the CIMD URL and
 * the document's `client_id` never disagree: `platform.mcpServer.publicUrl`
 * when an admin set it (required behind a reverse proxy so the redirect URI
 * registered with the authorization server stays stable), else the proxy-aware
 * `buildPublicBaseUrl(req)`, which includes iHub's base path.
 *
 * @module services/mcp/mcpOAuthPublicUrl
 */
import configCache from '../../configCache.js';
import { buildPublicBaseUrl } from '../../utils/publicBaseUrl.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getLocalizedString } from '../../utils/localize.js';

/** Route paths, relative to the public base (which already carries the base path). */
export const MCP_OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';
export const MCP_OAUTH_CLIENT_METADATA_PATH = '/api/mcp/oauth/client-metadata.json';
export const MCP_OAUTH_AUTHORIZE_PATH = '/api/mcp/oauth/authorize';

/** `client_name` cap of iHub's own CIMD validator. */
const MAX_CLIENT_NAME_LENGTH = 100;

/**
 * The public base URL, without a trailing slash.
 *
 * @param {import('express').Request} [req] - Needed when no `mcpServer.publicUrl` is configured
 * @returns {string|null} e.g. `https://ihub.example.com/ihub`, or null when unknown
 */
export function resolveMcpPublicBase(req) {
  const platform = configCache.getPlatform() || {};
  const configured = platform.mcpServer?.publicUrl;
  if (typeof configured === 'string' && /^https?:\/\//.test(configured.trim())) {
    return configured.trim().replace(/\/+$/, '');
  }
  if (!req) return null;
  try {
    return buildPublicBaseUrl(req).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * @param {string} publicBase
 * @returns {string} The redirect URI registered with authorization servers
 */
export function mcpCallbackUrl(publicBase) {
  return `${publicBase}${MCP_OAUTH_CALLBACK_PATH}`;
}

/**
 * @param {string} publicBase
 * @returns {string} The `client_id` URL of iHub's CIMD
 */
export function mcpClientMetadataUrl(publicBase) {
  return `${publicBase}${MCP_OAUTH_CLIENT_METADATA_PATH}`;
}

/**
 * Whether a public base may serve as a URL-based client id (SEP-991 requires https).
 * @param {string|null} publicBase
 * @returns {boolean}
 */
export function isCimdCapableBase(publicBase) {
  return typeof publicBase === 'string' && publicBase.startsWith('https://');
}

/**
 * The display name iHub registers under: the UI title, or "iHub Apps".
 * @returns {string}
 */
export function mcpClientName() {
  let title = '';
  try {
    title = getLocalizedString(configCache.getUI()?.data?.title, 'en', 'en', '');
  } catch {
    title = '';
  }
  const cleaned = String(title || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (cleaned || 'iHub Apps').slice(0, MAX_CLIENT_NAME_LENGTH);
}

/**
 * The OAuth client metadata iHub presents: the body of its CIMD (with
 * `client_id`) and the DCR request (without). Public client, authorization
 * code + refresh token, one fixed redirect URI — the same rules iHub's own
 * `validateClientMetadata` enforces on documents it fetches.
 *
 * @param {Object} params
 * @param {string} params.publicBase
 * @param {string} [params.clientName]
 * @param {boolean} [params.withClientId=true]
 * @returns {Object}
 */
export function buildMcpClientMetadata({ publicBase, clientName, withClientId = true }) {
  return {
    ...(withClientId ? { client_id: mcpClientMetadataUrl(publicBase) } : {}),
    client_name: clientName || mcpClientName(),
    client_uri: publicBase,
    redirect_uris: [mcpCallbackUrl(publicBase)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
}

/**
 * The path a user opens to connect a server (relative to the origin; carries
 * the base path). The caller appends `returnUrl`.
 *
 * @param {string} serverId
 * @returns {string}
 */
export function mcpConnectPath(serverId) {
  return `${buildServerPath(MCP_OAUTH_AUTHORIZE_PATH)}?serverId=${encodeURIComponent(serverId)}`;
}
