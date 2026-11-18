// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V256 — failed sign-in ceiling per address
 *
 * `rateLimit.authApi.perIpLimit` now counts only failed sign-ins per IP
 * address, so a sign-in wave behind one NAT address never reaches it. It
 * shipped at 5,000 (counting every attempt); one address could make 5,000
 * password guesses over as many usernames per window. Where the shipped 5,000
 * is still set, it becomes the new shipped value (300); an admin's own value
 * stays.
 *
 * The new value is read from server/defaults/config/platform.json.
 */
export const version = '256';
export const description = 'failed_sign_in_ceiling_per_address';

const PLATFORM_FILE = 'config/platform.json';

/** What `rateLimit.authApi.perIpLimit` shipped with (migration V254). */
export const PREVIOUS_PER_IP_LIMIT = 5000;

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
 * Lower the untouched per-address ceiling.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const platform = await ctx.readJson(PLATFORM_FILE);
  const authApi = platform.rateLimit?.authApi;
  if (authApi?.perIpLimit !== PREVIOUS_PER_IP_LIMIT) {
    ctx.log('rateLimit.authApi.perIpLimit not the shipped 5000 — skipping');
    return;
  }
  const shipped = await ctx.readDefaultJson(PLATFORM_FILE);
  authApi.perIpLimit = shipped.rateLimit.authApi.perIpLimit;
  await ctx.writeJson(PLATFORM_FILE, platform);
  ctx.log(`rateLimit.authApi.perIpLimit: 5000 → ${authApi.perIpLimit} failed sign-ins per address`);
}
