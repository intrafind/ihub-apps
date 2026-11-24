// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V263 — Seed the two new limits of what a personal app may use
 *
 * - `platform.userApps.capabilities.webSearchLimits.maxPageReads` — how many
 *   pages the page reader may open for one answer of a personal app, at most
 *   (10). An author sets the number in the app; this is the ceiling.
 * - `platform.userApps.capabilities.projects` — whether a personal app may link
 *   projects, the documents it answers from (off).
 *
 * Both are the built-in defaults, and the settings reader fills them when a key
 * is missing, so the upgrade changes nothing on its own; the migration makes the
 * settings visible in `platform.json`.
 *
 * A `platform.userApps` block is extended only where it exists: an installation
 * that never switched personal apps on has none, and the first save of the
 * settings writes the complete block. A value an admin already set is never
 * touched.
 */

export const version = '263';
export const description = 'user_apps_advanced_capabilities';

export const DEFAULT_MAX_PAGE_READS = 10;

/** What the migration seeds, by path below `userApps`. */
export const SEEDED_DEFAULTS = Object.freeze({
  'capabilities.webSearchLimits.maxPageReads': DEFAULT_MAX_PAGE_READS,
  'capabilities.projects': false
});

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  if (!platform.userApps || typeof platform.userApps !== 'object') {
    ctx.log('platform.userApps does not exist — nothing to extend');
    return;
  }
  let seeded = 0;
  for (const [key, value] of Object.entries(SEEDED_DEFAULTS)) {
    if (ctx.setDefault(platform, `userApps.${key}`, value)) seeded++;
  }
  if (seeded === 0) {
    ctx.log('platform.userApps already has both limits — no changes needed');
    return;
  }
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Seeded ${seeded} platform.userApps capability defaults`);
}
