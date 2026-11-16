// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V254 — limits for large installations
 *
 * The shipped limits were sized for a small team. Behind one corporate NAT
 * address a company of thousands shared one per-IP budget, so a few hundred
 * busy users got 429s; and every self-hosted model ran at most 5 calls at
 * once, although a vLLM GPU serves about 30 busy users together.
 *
 *   - The general limiters (`rateLimit.default`, `adminApi`, `publicApi`,
 *     `inferenceApi`) count a signed-in request per user (`keyBy: "user"`)
 *     and an anonymous request per IP address (`anonymousLimit`). Where the
 *     admin left the shipped per-IP limit, it becomes the new per-user limit.
 *     Where the admin set an own limit, it stays, now per user, and anonymous
 *     requests keep it per address.
 *   - `rateLimit.authApi` now counts per IP address and username; the new
 *     `perIpLimit` caps one address. An own limit higher than the shipped
 *     ceiling raises the ceiling too, so nothing gets stricter.
 *   - `requestConcurrencyLocal` is the concurrency of self-hosted models.
 *     Where `requestConcurrency` is still the shipped 5, they get the shipped
 *     value; where the admin set an own value, they keep it.
 *
 * The new values are read from server/defaults/config/platform.json, which is
 * also where fresh installs get them, so the defaults live in one place.
 */
export const version = '254';
export const description = 'limits_for_large_installations';

const PLATFORM_FILE = 'config/platform.json';

/** The general limiters and the per-IP limit each shipped with (per minute). */
export const PREVIOUS_GENERAL_LIMITS = Object.freeze({
  default: 100,
  adminApi: 100,
  publicApi: 500,
  inferenceApi: 500
});
const PREVIOUS_GENERAL_WINDOW_MS = 60000;

/** What `requestConcurrency` shipped with. */
export const PREVIOUS_REQUEST_CONCURRENCY = 5;

/**
 * Run only where a platform config exists.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<boolean>}
 */
export async function precondition(ctx) {
  return await ctx.fileExists(PLATFORM_FILE);
}

/**
 * Raise the untouched limits and add the new fields.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const platform = await ctx.readJson(PLATFORM_FILE);
  const shipped = await ctx.readDefaultJson(PLATFORM_FILE);
  let changed = false;
  const set = (path, value) => {
    if (ctx.setDefault(platform, path, value)) changed = true;
  };

  for (const [key, previousLimit] of Object.entries(PREVIOUS_GENERAL_LIMITS)) {
    const config = platform.rateLimit?.[key];
    // Without a section the built-in fallbacks apply; keyBy defaults to "user".
    if (!config) continue;
    const target = shipped.rateLimit[key];
    const untouched =
      config.limit === previousLimit && config.windowMs === PREVIOUS_GENERAL_WINDOW_MS;
    if (untouched && config.keyBy === undefined) {
      config.limit = target.limit;
      changed = true;
      ctx.log(`rateLimit.${key}: ${previousLimit} per IP → ${target.limit} per user per minute`);
    }
    set(`rateLimit.${key}.keyBy`, target.keyBy);
    // Anonymous requests keep an admin's own per-IP limit.
    set(
      `rateLimit.${key}.anonymousLimit`,
      untouched || typeof config.limit !== 'number' ? target.anonymousLimit : config.limit
    );
  }

  const authApi = platform.rateLimit?.authApi;
  if (authApi) {
    const ownLimit = typeof authApi.limit === 'number' ? authApi.limit : 0;
    set('rateLimit.authApi.perIpLimit', Math.max(shipped.rateLimit.authApi.perIpLimit, ownLimit));
  }

  const concurrency = platform.requestConcurrency;
  if (concurrency === PREVIOUS_REQUEST_CONCURRENCY) {
    set('requestConcurrencyLocal', shipped.requestConcurrencyLocal);
  } else if (typeof concurrency === 'number') {
    // An own value (or "unlimited" below 1) keeps applying to every model.
    set('requestConcurrencyLocal', concurrency);
  }

  if (changed) {
    await ctx.writeJson(PLATFORM_FILE, platform);
    ctx.log('Limits for large installations applied');
  } else {
    ctx.log('Limits already configured — skipping');
  }
}
