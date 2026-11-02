// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Service-account authentication: how a shared credential from the credential
 * store (`config/credentials.json`, referenced by `credentialRef` /
 * `*Ref` fields — never stored inline) becomes the headers of an outbound
 * request. One implementation for every integration that authenticates as
 * the installation rather than as the user: OpenAPI integrations and OpenAPI
 * tools, MCP servers and A2A agents with a shared secret.
 *
 * Kinds:
 *   - `bearer`  → `Authorization: Bearer <token>`
 *   - `basic`   → `Authorization: Basic base64(<user>:<password>)` (or of the secret as given)
 *   - `header`  → `<headerName>: <prefix><value>` (API keys in a header)
 *   - `apiKeyQuery` → a query parameter (OpenAPI credential profiles)
 *   - `oauth` / `oauth2` (client credentials) → a token from the token
 *     endpoint, cached until shortly before it expires ({@link ClientCredentialsTokenCache})
 *
 * The secrets are resolved at call time and never logged. The token request
 * is sent by the caller's own fetch (SSRF-guarded `safeFetch`, the A2A
 * client's bounded reader), so each integration keeps its outbound policy.
 *
 * @module services/integrations/auth/ServiceAccountAuth
 */
import credentialService from '../../CredentialService.js';

/** How early a cached client-credentials token counts as expired. */
const TOKEN_EXPIRY_SKEW_MS = 5000;
/** The lifetime assumed when a token response names none. */
const DEFAULT_TOKEN_LIFETIME_MS = 3600 * 1000;

/**
 * Resolve the `*Ref` fields of an auth block from the credential store into
 * the plain field names the header builders read (`tokenRef` → `token`, …).
 *
 * @param {Object} auth - Auth block with credential references
 * @param {Object<string, string>} refFields - `{ tokenRef: 'token', … }`
 * @param {Object} [options]
 * @param {(ref: string) => string} [options.resolveSecret] - Default: the credential store
 * @param {(refField: string, error: Error) => void} [options.onError] - Called before a failure is rethrown
 * @returns {Object} A copy of `auth` with the plain fields set
 * @throws {Error} When a referenced credential cannot be resolved
 *
 * @example
 *   resolveSecretRefs({ type: 'bearer', tokenRef: 'svc' }, { tokenRef: 'token' });
 *   // → { type: 'bearer', tokenRef: 'svc', token: '<secret>' }
 */
export function resolveSecretRefs(auth, refFields, { resolveSecret, onError } = {}) {
  const resolve = resolveSecret || (ref => credentialService.resolveSecret(ref));
  const out = { ...auth };
  for (const [refField, plainField] of Object.entries(refFields)) {
    if (typeof out[refField] === 'string' && out[refField]) {
      try {
        out[plainField] = resolve(out[refField]);
      } catch (error) {
        onError?.(refField, error);
        throw error;
      }
    }
  }
  return out;
}

/**
 * The `Authorization: Basic` value of a user and password.
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
export function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Static headers of a resolved auth block (`bearer`, `basic`, `header`,
 * `apiKey`). Client credentials are not static: see
 * {@link ClientCredentialsTokenCache}.
 *
 * @param {Object} auth - Resolved auth block
 * @param {Object} [options]
 * @param {string} [options.apiKeyHeader='X-API-Key'] - Header of an `apiKey` block without `headerName`
 * @returns {Object<string, string>}
 */
export function staticAuthHeaders(auth, { apiKeyHeader = 'X-API-Key' } = {}) {
  if (!auth || auth.type === 'none') return {};
  if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` };
  if (auth.type === 'basic')
    return { Authorization: basicAuthorization(auth.username, auth.password) };
  if (auth.type === 'header') {
    return { [auth.headerName]: `${auth.valuePrefix || ''}${auth.value}` };
  }
  if (auth.type === 'apiKey') return { [auth.headerName || apiKeyHeader]: auth.value };
  return {};
}

/**
 * The request authentication of a credential store profile (OpenAPI tools):
 * headers, an optional query parameter, and whether a client-credentials
 * token is needed.
 *
 * @param {Object} profile - Resolved credential profile (`credentialService.resolve`)
 * @returns {{headers: Object<string, string>, queryParam: ({name: string, value: string}|null), needsOAuthToken: boolean}}
 */
export function credentialProfileAuth(profile) {
  const headers = {};
  let queryParam = null;
  let needsOAuthToken = false;
  switch (profile?.type) {
    case 'bearer':
      headers.Authorization = `Bearer ${profile.token}`;
      break;
    case 'basic':
      headers.Authorization = basicAuthorization(profile.username, profile.password);
      break;
    case 'apiKeyHeader':
      headers[profile.headerName] = profile.key;
      break;
    case 'apiKeyQuery':
      queryParam = { name: profile.paramName, value: profile.key };
      break;
    case 'oauth2':
      needsOAuthToken = true;
      break;
    case 'secret':
      // Opaque secret with no request-auth mapping; treat as a bearer token.
      headers.Authorization = `Bearer ${profile.value}`;
      break;
    default:
      break;
  }
  return { headers, queryParam, needsOAuthToken };
}

/**
 * The headers of an installation in service-account mode, for a definition's
 * `auth.serviceAccount` (`kind`: `bearer`, `basic`, `header`; `header` and
 * `valuePrefix` for the header kind).
 *
 * @param {Object} params
 * @param {string} params.secret - The credential's value
 * @param {Object} [params.serviceAccount] - `definition.auth.serviceAccount`
 * @param {(template: string) => string} [params.fillTemplate] - Fills `{value}` placeholders in the header name
 * @returns {Object<string, string>}
 */
export function serviceAccountHeaders({ secret, serviceAccount = {}, fillTemplate = t => t }) {
  const kind = serviceAccount.kind || 'header';
  if (kind === 'bearer') return { Authorization: `Bearer ${secret}` };
  if (kind === 'basic') {
    return { Authorization: `Basic ${Buffer.from(String(secret)).toString('base64')}` };
  }
  const headerName = fillTemplate(serviceAccount.header || 'Authorization') || 'Authorization';
  return { [headerName]: `${serviceAccount.valuePrefix || ''}${secret}` };
}

/**
 * The form body of a client-credentials (or configured refresh-token) token request.
 *
 * @param {Object} params
 * @param {string} params.clientId
 * @param {string} params.clientSecret
 * @param {string} [params.scope]
 * @param {string} [params.grantType='client_credentials']
 * @param {string} [params.refreshToken] - With `grantType: 'refresh_token'`
 * @returns {URLSearchParams}
 */
export function clientCredentialsBody({
  clientId,
  clientSecret,
  scope,
  grantType = 'client_credentials',
  refreshToken
}) {
  const body = new URLSearchParams({ grant_type: grantType });
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  if (scope) body.set('scope', scope);
  if (grantType === 'refresh_token' && refreshToken) body.set('refresh_token', refreshToken);
  return body;
}

/**
 * Client-credentials access tokens, cached per key until shortly before they
 * expire. The token request itself is the caller's (`request`), so it runs
 * through the caller's outbound policy.
 */
export class ClientCredentialsTokenCache {
  /**
   * @param {Object} [options]
   * @param {() => number} [options.now]
   */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, {token: string, expiry: number}>} */
    this.entries = new Map();
  }

  /**
   * A cached token, or a new one from `request`.
   *
   * @param {string} key - What the token is for (a credential ref, a server id)
   * @param {() => Promise<{access_token?: string, expires_in?: number}>} request - Fetches a token response
   * @returns {Promise<string>}
   * @throws {Error} When the response carries no access token (or `request` throws)
   */
  async getToken(key, request) {
    const cached = this.entries.get(key);
    const now = this.now();
    if (cached && cached.expiry > now + TOKEN_EXPIRY_SKEW_MS) return cached.token;
    const data = await request();
    if (!data?.access_token) throw new Error('OAuth token response missing access_token');
    const lifetime = data.expires_in ? data.expires_in * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
    this.entries.set(key, { token: data.access_token, expiry: now + lifetime });
    return data.access_token;
  }

  /** Forget every cached token (a config change). */
  clear() {
    this.entries.clear();
  }
}
