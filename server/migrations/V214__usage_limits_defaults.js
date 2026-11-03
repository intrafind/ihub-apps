// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V214 — Seed the usage limit settings
 *
 * Token budgets per model, group and user (services/quota) reset on a
 * built-in schedule: daily at `dailyAt`, weekly on `weeklyOn` at `weeklyAt`
 * and monthly on the 1st at `monthlyAt`, in `timezone` (the server's zone
 * when null). `allModels` is the platform-wide budget across all models,
 * empty (unlimited) by default — nothing is limited until an admin sets a
 * limit.
 */

export const version = '214';
export const description = 'usage_limits_defaults';

export const USAGE_LIMITS_DEFAULTS = Object.freeze({
  timezone: null,
  dailyAt: '00:00',
  weeklyOn: 'monday',
  weeklyAt: '00:00',
  monthlyAt: '00:00'
});

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'usageLimits.allModels', {});
  for (const [key, value] of Object.entries(USAGE_LIMITS_DEFAULTS)) {
    ctx.setDefault(platform, `usageLimits.resets.${key}`, value);
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added usageLimits defaults (no limits; resets daily 00:00, Monday 00:00, 1st 00:00)');
}
