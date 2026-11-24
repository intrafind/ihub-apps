// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V263 — Seed how far web search may be tuned in a personal app
 *
 * A personal app may set how many pages the page reader opens for one answer
 * (`capabilities.webSearchSettings.maxPageReads`). The administrator's limit is
 * `platform.userApps.capabilities.webSearchLimits.maxPageReads`. This migration
 * seeds it with the built-in default (10), so the setting is visible in
 * `platform.json`. The settings reader fills the same value when the key is
 * missing, so the upgrade changes nothing on its own.
 *
 * A `platform.userApps` block is extended only where it exists: an installation
 * that never switched personal apps on has none, and the first save of the
 * settings writes the complete block. A value an admin already set is never
 * touched.
 */

export const version = '263';
export const description = 'user_apps_web_search_limits';

export const DEFAULT_MAX_PAGE_READS = 10;

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  if (!platform.userApps || typeof platform.userApps !== 'object') {
    ctx.log('platform.userApps does not exist — nothing to extend');
    return;
  }
  const seeded = ctx.setDefault(
    platform,
    'userApps.capabilities.webSearchLimits.maxPageReads',
    DEFAULT_MAX_PAGE_READS
  );
  if (!seeded) {
    ctx.log('platform.userApps already has a web search limit — no changes needed');
    return;
  }
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    `Seeded platform.userApps.capabilities.webSearchLimits.maxPageReads=${DEFAULT_MAX_PAGE_READS}`
  );
}
