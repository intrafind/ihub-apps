/**
 * Migration V159 — OAuth rate limits sized for real traffic, and configurable
 *
 * Two limiters guard the OAuth server (see server/middleware/rateLimiting.js):
 *
 *   - `rateLimit.oauthApi` counts every request under /api/oauth per address.
 *     It shipped at 50 requests per 15 minutes. That is too few for a consent
 *     screen opened from browsers behind one corporate NAT address, and far
 *     too few for a server-side client such as Microsoft 365 Copilot, which
 *     exchanges and refreshes every one of its users' tokens from a handful of
 *     Microsoft addresses. It becomes 300 requests per minute — but only where
 *     the admin left the shipped values alone.
 *
 *   - `rateLimit.oauthTokenApi` is new. It replaces a hard-coded limit of 20
 *     requests per 15 minutes on /api/oauth/token and covers
 *     /api/oauth/introspect too: the two endpoints that check a client secret.
 *     It counts only failed requests, so guessing secrets stops after 30
 *     attempts while clients that authenticate correctly are never slowed.
 *
 * Fresh installs get both from server/defaults/config/platform.json.
 */
export const version = '159';
export const description = 'realistic_oauth_rate_limits';

/** What `rateLimit.oauthApi` shipped with (V008 and the defaults). */
export const PREVIOUS_OAUTH_API = Object.freeze({ windowMs: 900000, limit: 50 });

export const OAUTH_API_DEFAULTS = Object.freeze({ windowMs: 60000, limit: 300 });

export const OAUTH_TOKEN_API_DEFAULTS = Object.freeze({
  windowMs: 900000,
  limit: 30,
  skipSuccessfulRequests: true,
  skipFailedRequests: false
});

/**
 * Run only where a platform config exists.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<boolean>}
 */
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Raise the untouched OAuth limit and add the token limit.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  let changed = false;

  const oauthApi = platform.rateLimit?.oauthApi;
  const untouched =
    oauthApi &&
    oauthApi.windowMs === PREVIOUS_OAUTH_API.windowMs &&
    oauthApi.limit === PREVIOUS_OAUTH_API.limit;
  if (untouched) {
    oauthApi.windowMs = OAUTH_API_DEFAULTS.windowMs;
    oauthApi.limit = OAUTH_API_DEFAULTS.limit;
    changed = true;
    ctx.log('Raised rateLimit.oauthApi from 50 per 15 minutes to 300 per minute');
  } else {
    // An admin's own values stay; only what is missing is filled in.
    for (const [key, value] of Object.entries(OAUTH_API_DEFAULTS)) {
      if (ctx.setDefault(platform, `rateLimit.oauthApi.${key}`, value)) changed = true;
    }
    if (oauthApi) ctx.log('rateLimit.oauthApi was customised — keeping it');
  }

  for (const [key, value] of Object.entries(OAUTH_TOKEN_API_DEFAULTS)) {
    if (ctx.setDefault(platform, `rateLimit.oauthTokenApi.${key}`, value)) changed = true;
  }

  if (changed) {
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('OAuth rate limits updated');
  } else {
    ctx.log('OAuth rate limits already configured — skipping');
  }
}
