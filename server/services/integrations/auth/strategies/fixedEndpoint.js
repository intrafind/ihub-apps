// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The fixed-endpoint strategy of {@link module:services/integrations/auth/OAuthUserClient}:
 * an authorization server whose endpoints are known up front (Atlassian
 * Cloud, the Microsoft identity platform of one tenant, Google, a Nextcloud
 * server) and a client iHub was registered as by an admin (client id plus a
 * secret from the credential store).
 *
 * Every request goes through `httpFetch`, so the admin's outbound proxy and
 * the SSL whitelist (`ssl.ignoreInvalidCertificates` + `ssl.domainWhitelist`)
 * apply — a self-hosted Nextcloud with a private CA keeps working.
 *
 * @module services/integrations/auth/strategies/fixedEndpoint
 */
import { httpFetch } from '../../../../utils/httpConfig.js';

/**
 * @param {Object} options
 * @param {string} options.id - Strategy id for logs, e.g. `fixed:jira`
 * @param {string} options.issuer - Issuer identifier the credentials are keyed by
 * @param {string} options.authorizationEndpoint
 * @param {string} options.tokenEndpoint
 * @param {string} [options.revocationEndpoint] - RFC 7009 endpoint, when the provider has one
 * @param {string} options.clientId
 * @param {string|(() => string)} [options.clientSecret] - The secret, or a function that
 *   resolves it from the credential store; a function is only called for token and
 *   revocation requests, so building the authorization URL never needs the secret
 * @param {'client_secret_post'|'client_secret_basic'|'none'} [options.clientAuthMethod='client_secret_post']
 * @param {string[]} [options.scopes]
 * @param {Object<string, string>} [options.extraAuthorizationParams]
 * @param {Object<string, string>} [options.extraRefreshParams]
 * @param {Function} [options.fetchFn=httpFetch] - Test seam
 * @returns {import('../OAuthUserClient.js').OAuthStrategy}
 *
 * @example
 *   const strategy = createFixedEndpointStrategy({
 *     id: 'fixed:googledrive',
 *     issuer: 'https://accounts.google.com',
 *     authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
 *     tokenEndpoint: 'https://oauth2.googleapis.com/token',
 *     clientId, clientSecret, scopes: ['openid']
 *   });
 */
export function createFixedEndpointStrategy({
  id,
  issuer,
  authorizationEndpoint,
  tokenEndpoint,
  revocationEndpoint,
  clientId,
  clientSecret,
  clientAuthMethod = 'client_secret_post',
  scopes = [],
  extraAuthorizationParams = {},
  extraRefreshParams = {},
  fetchFn = httpFetch
}) {
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(`OAuth strategy ${id}: authorization and token endpoints are required`);
  }
  if (!clientId) throw new Error(`OAuth strategy ${id}: no client id configured`);
  const base = {
    issuer,
    authorizationServerUrl: issuer,
    metadata: Object.freeze({
      issuer,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      ...(revocationEndpoint ? { revocation_endpoint: revocationEndpoint } : {}),
      response_types_supported: ['code']
    }),
    clientAuthMethod,
    scopes: [...scopes],
    extraAuthorizationParams: { ...extraAuthorizationParams },
    extraRefreshParams: { ...extraRefreshParams },
    issRequired: false,
    fetchFn
  };
  return {
    id,
    async resolve(ctx = {}) {
      const secret =
        ctx.purpose === 'authorize'
          ? undefined
          : typeof clientSecret === 'function'
            ? clientSecret()
            : clientSecret;
      return {
        ...base,
        clientInformation: Object.freeze({
          client_id: clientId,
          ...(secret ? { client_secret: secret } : {})
        })
      };
    }
  };
}
