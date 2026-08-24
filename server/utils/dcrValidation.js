import { MCP_SCOPE_LIST } from '../services/mcp/scopes.js';

/**
 * Validation for RFC 7591 Dynamic Client Registration requests.
 *
 * Kept free of Express/config dependencies so the security-relevant rules are
 * unit-testable in isolation. The policy is deliberately narrower than the
 * RFC allows:
 *   - only the authorization_code (+ refresh_token) grant can be registered —
 *     client_credentials service accounts must be created by an admin,
 *   - redirect URIs must be https, loopback http, or a private-use scheme
 *     (RFC 8252 native apps); dangerous schemes are always rejected,
 *   - grantable scopes are limited to an allowlist (identity + mcp:*).
 */

export const DCR_DEFAULT_ALLOWED_SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
  ...MCP_SCOPE_LIST
]);

export const DCR_ALLOWED_GRANT_TYPES = Object.freeze(['authorization_code', 'refresh_token']);

export const DCR_ALLOWED_AUTH_METHODS = Object.freeze([
  'none',
  'client_secret_post',
  'client_secret_basic'
]);

// Schemes that must never be redirect targets: script/local-content schemes
// (XSS vectors) plus well-known network/navigation schemes that are not
// app-callback schemes. Anything else that is neither https nor loopback
// http is treated as a private-use native-app scheme (RFC 8252 §7.1) — a
// positive allowlist is impossible since every native MCP client picks its
// own scheme (cursor://…, vscode://…, com.example.app://…).
const DENIED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'ftp:',
  'ftps:',
  'sftp:',
  'ws:',
  'wss:',
  'mailto:',
  'tel:',
  'ssh:',
  'telnet:',
  'smb:',
  'ldap:',
  'ldaps:',
  'gopher:',
  'intent:',
  'chrome:',
  'chrome-extension:',
  'moz-extension:'
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_NAME_LENGTH = 100;
const MAX_SCOPE_LENGTH = 500;

/**
 * Validate a single redirect URI against the DCR policy.
 *
 * @param {*} uri - Candidate redirect URI
 * @returns {{ ok: boolean, reason?: string }} Validation result
 */
export function validateRedirectUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) {
    return { ok: false, reason: 'redirect URI must be a non-empty string' };
  }
  if (uri.length > MAX_URI_LENGTH) {
    return { ok: false, reason: `redirect URI exceeds ${MAX_URI_LENGTH} characters` };
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: `redirect URI is not a valid URI: ${uri}` };
  }

  if (parsed.hash) {
    return { ok: false, reason: 'redirect URI must not contain a fragment' };
  }

  const scheme = parsed.protocol;
  if (DENIED_SCHEMES.has(scheme)) {
    return { ok: false, reason: `redirect URI scheme not allowed: ${scheme}` };
  }

  if (scheme === 'https:') {
    return { ok: true };
  }

  if (scheme === 'http:') {
    // Plain http is only acceptable for loopback redirects (RFC 8252 §7.3).
    if (LOOPBACK_HOSTS.has(parsed.hostname)) {
      return { ok: true };
    }
    return { ok: false, reason: 'http redirect URIs are only allowed for loopback addresses' };
  }

  // Anything else is treated as a private-use URI scheme for native apps
  // (RFC 8252 §7.1), e.g. cursor://…, vscode://…. Note that DCR necessarily
  // allows arbitrary attacker-controlled https targets too — the mandatory
  // user consent screen, not the scheme, is the actual authorization gate.
  return { ok: true };
}

/**
 * Strip control characters and clamp length for display strings taken from
 * an unauthenticated registration request.
 *
 * @param {*} value - Raw input value
 * @param {number} maxLength - Maximum length to keep
 * @returns {string} Sanitized string ('' when not a string)
 */
function sanitizeDisplayString(value, maxLength) {
  if (typeof value !== 'string') return '';

  return value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .substring(0, maxLength);
}

/**
 * Validate an RFC 7591 registration request body and derive the client data
 * to store.
 *
 * @param {Object} body - Parsed JSON request body
 * @param {Object} [options] - Policy options
 * @param {Array<string>} [options.allowedScopes] - Scope allowlist override
 * @returns {{ ok: false, error: string, errorDescription: string } |
 *           { ok: true, clientMetadata: Object }} Validation outcome; on
 *           success `clientMetadata` carries the normalized registration
 *           values (name, redirectUris, grantTypes, tokenEndpointAuthMethod,
 *           scopes, softwareId, softwareVersion).
 */
export function validateRegistrationRequest(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      errorDescription: 'Request body must be a JSON object'
    };
  }

  // --- redirect_uris (required) ---
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      errorDescription: 'redirect_uris is required and must be a non-empty array'
    };
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      errorDescription: `At most ${MAX_REDIRECT_URIS} redirect URIs are allowed`
    };
  }
  for (const uri of redirectUris) {
    const result = validateRedirectUri(uri);
    if (!result.ok) {
      return { ok: false, error: 'invalid_redirect_uri', errorDescription: result.reason };
    }
  }

  // --- grant_types ---
  let grantTypes = [...DCR_ALLOWED_GRANT_TYPES];
  if (body.grant_types !== undefined) {
    if (!Array.isArray(body.grant_types) || body.grant_types.length === 0) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        errorDescription: 'grant_types must be a non-empty array'
      };
    }
    const invalid = body.grant_types.filter(g => !DCR_ALLOWED_GRANT_TYPES.includes(g));
    if (invalid.length > 0) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        errorDescription: `Unsupported grant types for dynamic registration: ${invalid.join(', ')}`
      };
    }
    if (!body.grant_types.includes('authorization_code')) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        errorDescription: 'Dynamically registered clients must use the authorization_code grant'
      };
    }
    grantTypes = [...new Set(body.grant_types)];
  }

  // --- response_types ---
  if (body.response_types !== undefined) {
    if (
      !Array.isArray(body.response_types) ||
      body.response_types.some(r => r !== 'code') ||
      body.response_types.length === 0
    ) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        errorDescription: 'Only the "code" response type is supported'
      };
    }
  }

  // --- token_endpoint_auth_method ---
  let tokenEndpointAuthMethod = 'none';
  if (body.token_endpoint_auth_method !== undefined) {
    if (!DCR_ALLOWED_AUTH_METHODS.includes(body.token_endpoint_auth_method)) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        errorDescription: `Unsupported token_endpoint_auth_method. Supported: ${DCR_ALLOWED_AUTH_METHODS.join(', ')}`
      };
    }
    tokenEndpointAuthMethod = body.token_endpoint_auth_method;
  }

  // --- scope ---
  const allowedScopes =
    Array.isArray(options.allowedScopes) && options.allowedScopes.length > 0
      ? options.allowedScopes
      : DCR_DEFAULT_ALLOWED_SCOPES;

  let scopes = [...allowedScopes];
  if (body.scope !== undefined) {
    if (typeof body.scope !== 'string' || body.scope.length > MAX_SCOPE_LENGTH) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        errorDescription: 'scope must be a space-separated string'
      };
    }
    const requested = body.scope.split(' ').filter(Boolean);
    if (requested.length > 0) {
      const granted = requested.filter(s => allowedScopes.includes(s));
      if (granted.length === 0) {
        return {
          ok: false,
          error: 'invalid_client_metadata',
          errorDescription: `None of the requested scopes are grantable. Grantable scopes: ${allowedScopes.join(' ')}`
        };
      }
      scopes = granted;
    }
  }

  const name = sanitizeDisplayString(body.client_name, MAX_NAME_LENGTH) || 'MCP Client';

  return {
    ok: true,
    clientMetadata: {
      name,
      redirectUris,
      grantTypes,
      tokenEndpointAuthMethod,
      scopes,
      softwareId: sanitizeDisplayString(body.software_id, MAX_NAME_LENGTH),
      softwareVersion: sanitizeDisplayString(body.software_version, MAX_NAME_LENGTH)
    }
  };
}
