// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// server/migrations/V254__admin_api_rate_limit_default.js
export const version = '254';
export const description = 'admin_api_rate_limit_default';

/**
 * The admin API limit (`rateLimit.adminApi`) shipped at 100 requests per minute.
 * A single admin page fires many requests on load, so one admin working through
 * a few pages ran into 429s, and admins behind one address shared that budget.
 *
 * The limiter now counts per signed-in user (server/middleware/rateLimiting.js),
 * and the shipped limit becomes 500 per minute, the value the code already falls
 * back to. Only the untouched shipped values (100 per 60000 ms) are raised; a
 * limit or window an admin set stays as it is, and so does an install without an
 * `adminApi` section (it already runs with 500).
 *
 * Fresh installs get 500 from server/defaults/config/platform.json.
 */

const PLATFORM_FILE = 'config/platform.json';

/** What `rateLimit.adminApi` shipped with. */
export const PREVIOUS_ADMIN_API = Object.freeze({ windowMs: 60000, limit: 100 });

/** The new shipped limit. */
export const ADMIN_API_LIMIT = 500;

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
 * Raise the untouched shipped admin API limit to 500.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const platform = await ctx.readJson(PLATFORM_FILE);
  const adminApi = platform?.rateLimit?.adminApi;

  if (!adminApi || typeof adminApi !== 'object') {
    ctx.log('No rateLimit.adminApi section — the built-in 500 per minute applies, skipping');
    return;
  }

  const untouched =
    adminApi.limit === PREVIOUS_ADMIN_API.limit &&
    adminApi.windowMs === PREVIOUS_ADMIN_API.windowMs;
  if (!untouched) {
    ctx.log(
      `rateLimit.adminApi was customised (limit ${adminApi.limit}, windowMs ${adminApi.windowMs}) — keeping it`
    );
    return;
  }

  adminApi.limit = ADMIN_API_LIMIT;
  await ctx.writeJson(PLATFORM_FILE, platform);
  ctx.log('Raised rateLimit.adminApi from 100 to 500 requests per minute');
}
