/**
 * Migration V008: Add OAuth API rate limit configuration defaults
 *
 * This migration adds the `oauthApi` key to the `rateLimit` section of
 * platform.json so that administrators can tune the rate limit applied to
 * the OAuth token / authorize endpoints independently of the general auth
 * rate limiter.
 *
 * Default values mirror the auth API limiter but are slightly more generous
 * (50 vs 30 requests per 15 minutes) to accommodate automated OAuth clients
 * that legitimately exchange tokens frequently (e.g. SPA token refresh).
 *
 * Fields added to `rateLimit` section of platform.json:
 *   - oauthApi.windowMs            Window duration in milliseconds (default: 900000 = 15 min)
 *   - oauthApi.limit               Maximum requests per window (default: 50)
 *   - oauthApi.skipFailedRequests  Whether to skip failed requests (default: false)
 *
 * Junior contributor note:
 *   - Do NOT modify this file after it has been deployed; the migration
 *     runner tracks its checksum. To undo a change, create a new higher-
 *     versioned migration instead.
 *   - `ctx.setDefault` only writes a value when the key is absent, so
 *     any admin-configured value is preserved automatically.
 */

export const version = '008';
export const description = 'add_oauth_rate_limit';

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
 * Apply the migration: inject oauthApi rate limit defaults into platform.json.
 *
 * @param {import('../migrations/runner.js').MigrationContext} ctx
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // 15-minute sliding window for the OAuth endpoints (same as auth API)
  ctx.setDefault(platform, 'rateLimit.oauthApi.windowMs', 900000);

  // 50 requests per window — stricter than the public API but generous enough
  // for legitimate OAuth client traffic (e.g. silent token refresh in SPAs)
  ctx.setDefault(platform, 'rateLimit.oauthApi.limit', 50);

  // Always count failed requests against the limit to discourage brute-force
  // credential stuffing against the /token and /authorize endpoints
  ctx.setDefault(platform, 'rateLimit.oauthApi.skipFailedRequests', false);

  await ctx.writeJson('config/platform.json', platform);

  ctx.log(
    'Added rateLimit.oauthApi defaults ' + '(windowMs=900000, limit=50, skipFailedRequests=false)'
  );
}
