/**
 * The public identity iHub presents to an outbound authorization server:
 * the base URL, the per-server OAuth callback, the per-server Client ID
 * Metadata Document (CIMD) and the "Connect" path the chat and Settings send
 * users to.
 *
 * One helper decides the public base so the redirect URI, the CIMD URL and
 * the document's `client_id` never disagree: `platform.mcpServer.publicUrl`
 * when an admin set it (required behind a reverse proxy so the redirect URI
 * registered with the authorization server stays stable), else the request's
 * own protocol and host as Express resolves them — which honours
 * `X-Forwarded-Proto` / `X-Forwarded-Host` only when `trust proxy` trusts the
 * connecting peer — plus iHub's base path. A base derived from a request is
 * never trusted to replace an existing client registration (see
 * `mcpOAuthService.resolveClientRegistration`).
 *
 * Every server gets its own redirect URI (`…/api/mcp/oauth/callback/<id>`)
 * and its own CIMD (`…/api/mcp/oauth/client-metadata/<id>`): a code delivered
 * to one server's callback can never complete another server's sign-in
 * (OAuth mix-up defence, RFC 9700 §4.4.2), and each document lists exactly
 * the one redirect URI its client uses.
 *
 * @module services/mcp/mcpOAuthPublicUrl
 */
import configCache from '../../configCache.js';
import { buildServerPath, getBasePath } from '../../utils/basePath.js';
import { getLocalizedString } from '../../utils/localize.js';

/** Route paths, relative to the public base (which already carries the base path). */
export const MCP_OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';
export const MCP_OAUTH_CLIENT_METADATA_PATH = '/api/mcp/oauth/client-metadata';
export const MCP_OAUTH_AUTHORIZE_PATH = '/api/mcp/oauth/authorize';

/**
 * Stand-in base for a provider built without one. It only ever ends up in an
 * authorization URL the server-side provider throws away (it never
 * redirects), never in a request.
 */
export const PLACEHOLDER_PUBLIC_BASE = 'https://ihub.invalid';

/** `client_name` cap of iHub's own CIMD validator. */
const MAX_CLIENT_NAME_LENGTH = 100;

/** A host as Express reports it: name or IP literal, optional port — nothing else. */
const HOST_PATTERN = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/;

/**
 * The configured public base (`platform.mcpServer.publicUrl`), or null.
 * @returns {string|null}
 */
export function configuredMcpPublicBase() {
  const platform = configCache.getPlatform() || {};
  const configured = platform.mcpServer?.publicUrl;
  if (typeof configured === 'string' && /^https?:\/\//.test(configured.trim())) {
    return configured.trim().replace(/\/+$/, '');
  }
  return null;
}

/**
 * The base derived from a request: Express's `req.protocol` and `req.host`
 * (which read `X-Forwarded-Proto` / `X-Forwarded-Host` only when the app's
 * `trust proxy` setting trusts the connecting peer), plus the base path.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function requestPublicBase(req) {
  const host = typeof req.host === 'string' && req.host ? req.host : req.get?.('host');
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return null;
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return `${proto}://${host}${getBasePath()}`.replace(/\/+$/, '');
}

/**
 * The public base and whether an admin configured it.
 *
 * @param {import('express').Request} [req] - Needed when no `mcpServer.publicUrl` is configured
 * @returns {{publicBase: (string|null), configured: boolean}}
 */
export function resolveMcpPublicBaseInfo(req) {
  const configured = configuredMcpPublicBase();
  if (configured) return { publicBase: configured, configured: true };
  if (!req) return { publicBase: null, configured: false };
  try {
    return { publicBase: requestPublicBase(req), configured: false };
  } catch {
    return { publicBase: null, configured: false };
  }
}

/**
 * The public base URL, without a trailing slash.
 *
 * @param {import('express').Request} [req] - Needed when no `mcpServer.publicUrl` is configured
 * @returns {string|null} e.g. `https://ihub.example.com/ihub`, or null when unknown
 */
export function resolveMcpPublicBase(req) {
  return resolveMcpPublicBaseInfo(req).publicBase;
}

/**
 * @param {string} publicBase
 * @param {string} serverId
 * @returns {string} The redirect URI of one server, registered with its authorization server
 */
export function mcpCallbackUrl(publicBase, serverId) {
  return `${publicBase}${MCP_OAUTH_CALLBACK_PATH}/${encodeURIComponent(serverId)}`;
}

/**
 * @param {string} publicBase
 * @param {string} serverId
 * @returns {string} The `client_id` URL of iHub's CIMD for one server
 */
export function mcpClientMetadataUrl(publicBase, serverId) {
  return `${publicBase}${MCP_OAUTH_CLIENT_METADATA_PATH}/${encodeURIComponent(serverId)}`;
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
 * The OAuth client metadata iHub presents for one server: the body of that
 * server's CIMD (with `client_id`) and its DCR request (without). Public
 * client, authorization code + refresh token, exactly one redirect URI — the
 * server's own callback — the same rules iHub's own `validateClientMetadata`
 * enforces on documents it fetches.
 *
 * @param {Object} params
 * @param {string} params.publicBase
 * @param {string} params.serverId
 * @param {string} [params.clientName]
 * @param {boolean} [params.withClientId=true]
 * @returns {Object}
 */
export function buildMcpClientMetadata({ publicBase, serverId, clientName, withClientId = true }) {
  return {
    ...(withClientId ? { client_id: mcpClientMetadataUrl(publicBase, serverId) } : {}),
    client_name: clientName || mcpClientName(),
    client_uri: publicBase,
    redirect_uris: [mcpCallbackUrl(publicBase, serverId)],
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
