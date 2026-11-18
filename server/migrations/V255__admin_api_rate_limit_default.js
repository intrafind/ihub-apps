// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// server/migrations/V255__admin_api_rate_limit_default.js
export const version = '255';
export const description = 'admin_api_rate_limit_default';

/**
 * The admin API limit (`rateLimit.adminApi`) shipped at 100 requests per minute
 * per address. A single admin page fires many requests on load, so one admin
 * working through a few pages ran into 429s, and admins behind one address
 * shared that budget.
 *
 * V254 (limits_for_large_installations) already turns the untouched shipped
 * value into the new per-user one, but only where `keyBy` is not set yet. This
 * migration runs after it and raises an `adminApi` section that still has the
 * old 100 per 60000 ms to the shipped value of
 * server/defaults/config/platform.json, so the one case V254 leaves (an admin
 * who set `keyBy` but kept the old limit) gets it too. It never writes a value
 * of its own: the shipped defaults file is the single source, so this
 * migration cannot undo or contradict what V254 set.
 *
 * A limit or window an admin set stays as it is, and so does an install
 * without an `adminApi` section (the built-in fallback applies).
 */

const PLATFORM_FILE = 'config/platform.json';

/** What `rateLimit.adminApi` shipped with before V254. */
export const PREVIOUS_ADMIN_API = Object.freeze({ windowMs: 60000, limit: 100 });

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
 * Raise a still-untouched shipped admin API limit to the shipped default.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const platform = await ctx.readJson(PLATFORM_FILE);
  const adminApi = platform?.rateLimit?.adminApi;

  if (!adminApi || typeof adminApi !== 'object') {
    ctx.log('No rateLimit.adminApi section — the built-in fallback applies, skipping');
    return;
  }

  const shippedLimit = (await ctx.readDefaultJson(PLATFORM_FILE)).rateLimit.adminApi.limit;
  if (adminApi.limit === shippedLimit) {
    // Already the shipped value: set by V254, by an admin, or this migration ran before.
    ctx.log(`rateLimit.adminApi is already ${shippedLimit} requests per window — nothing to do`);
    return;
  }

  const untouched =
    adminApi.limit === PREVIOUS_ADMIN_API.limit &&
    adminApi.windowMs === PREVIOUS_ADMIN_API.windowMs;
  if (!untouched) {
    ctx.log(
      `rateLimit.adminApi was customized (limit ${adminApi.limit}, windowMs ${adminApi.windowMs}) — keeping it`
    );
    return;
  }

  adminApi.limit = shippedLimit;
  await ctx.writeJson(PLATFORM_FILE, platform);
  ctx.log(`Raised rateLimit.adminApi from 100 to ${shippedLimit} requests per minute`);
}
