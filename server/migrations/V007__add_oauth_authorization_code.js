/**
 * Migration V007: Add OAuth Authorization Code Flow configuration defaults
 *
 * This migration adds the configuration fields required to enable the
 * OAuth 2.0 Authorization Code Flow (with optional PKCE) to an existing
 * iHub Apps installation. All new fields default to safe/disabled values
 * so that existing installations are not affected until an admin
 * deliberately enables the feature.
 *
 * Fields added to `oauth` section of platform.json:
 *   - authorizationCodeEnabled       Enable authorization code grant type
 *   - issuer                         JWT issuer URL (required for OIDC discovery)
 *   - authorizationCodeExpirationSeconds  Lifetime of one-time auth codes
 *   - refreshTokenEnabled            Enable refresh token grant type
 *   - refreshTokenExpirationDays     Lifetime of refresh tokens
 *   - consentRequired                Require user consent screen per client
 *   - consentMemoryDays              How long remembered consent is valid
 *
 * Junior contributor note:
 *   - Do NOT modify this file after it has been deployed; the migration
 *     runner tracks its checksum. To undo a change, create a new higher-
 *     versioned migration instead.
 *   - `ctx.setDefault` only writes a value when the key is absent, so
 *     any admin-configured value is preserved automatically.
 */

export const version = '007';
export const description = 'add_oauth_authorization_code';

/**
 * Precondition: only run if platform.json exists.
 *
 * @param {import('../migrations/runner.js').MigrationContext} ctx
 * @returns {Promise<boolean>} true if the migration should run
 */
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Apply the migration: inject OAuth Authorization Code Flow defaults.
 *
 * @param {import('../migrations/runner.js').MigrationContext} ctx
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Enable/disable authorization code grant support (disabled by default for safety)
  ctx.setDefault(platform, 'oauth.authorizationCodeEnabled', false);

  // Issuer URL used in JWT `iss` claim and OIDC discovery document.
  // Must be set by the administrator before enabling the flow.
  ctx.setDefault(platform, 'oauth.issuer', '');

  // How many seconds a one-time authorization code is valid before expiring.
  // RFC 6749 recommends a short lifetime (≤10 min); 600 s = 10 minutes.
  ctx.setDefault(platform, 'oauth.authorizationCodeExpirationSeconds', 600);

  // Enable refresh token issuance alongside access tokens (disabled by default)
  ctx.setDefault(platform, 'oauth.refreshTokenEnabled', false);

  // How many days a refresh token remains valid before requiring re-authentication
  ctx.setDefault(platform, 'oauth.refreshTokenExpirationDays', 30);

  // Require an explicit user consent screen for each client (recommended: true)
  ctx.setDefault(platform, 'oauth.consentRequired', true);

  // How many days a granted consent is remembered before asking again
  ctx.setDefault(platform, 'oauth.consentMemoryDays', 90);

  await ctx.writeJson('config/platform.json', platform);

  ctx.log(
    'Added OAuth Authorization Code Flow configuration defaults ' +
      '(authorizationCodeEnabled, issuer, authorizationCodeExpirationSeconds, ' +
      'refreshTokenEnabled, refreshTokenExpirationDays, consentRequired, consentMemoryDays)'
  );
}
