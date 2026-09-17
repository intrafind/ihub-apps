/**
 * Migration V092 — Make the app shortcuts configurable in ui.json
 *
 * The start page's app grid and the sidebar's Apps section used to be
 * hard-coded: four apps on the start page, five in the sidebar, ranked
 * favorites-first and then by the app's `order`. Admins can now configure both
 * lists under Admin → UI Customization → Start Page, through new fields in the
 * `startPage` section of ui.json:
 *
 * - `appsMode`         — how apps that are neither favorites nor default apps
 *                        rank: `order` (the app's `order` field) or `recent`
 *                        (each user's most recently used apps first).
 * - `appsCount`        — how many apps the start page grid shows.
 * - `sidebarAppsCount` — how many apps the sidebar's Apps section shows.
 * - `featuredAppIds`   — the default apps, shown in this order right after
 *                        each user's favorites.
 *
 * The seeded values are exactly the behaviour installs already have, so
 * upgrading changes nothing on screen. `featuredAppIds` is seeded as an empty
 * list: with no default apps picked, both lists keep following `appsMode`.
 */

export const version = '092';
export const description = 'Make the app shortcuts configurable in ui.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  ctx.setDefault(ui, 'startPage.appsMode', 'order');
  ctx.setDefault(ui, 'startPage.appsCount', 4);
  ctx.setDefault(ui, 'startPage.sidebarAppsCount', 5);
  ctx.setDefault(ui, 'startPage.featuredAppIds', []);

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Applied app-shortcut defaults (startPage.appsMode, counts, featuredAppIds)');
}
