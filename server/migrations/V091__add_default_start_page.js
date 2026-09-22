/**
 * Migration V091 — Make the home view configurable in ui.json
 *
 * "/" always rendered the personalized start page. Admins can now choose what
 * home is, under Admin → UI Customization → Start Page, via a new field in the
 * `startPage` section of ui.json:
 *
 * - `defaultPage`      — `start` (the personalized start page, the default),
 *                        `apps` (the apps browser), `page` (a content page) or
 *                        `app` (an app's chat).
 * - `defaultPageId`    — the content page shown when `defaultPage` is `page`.
 * - `defaultPageAppId` — the app opened when `defaultPage` is `app`.
 *
 * Only `defaultPage` is seeded, with the behaviour installs already have, so
 * nothing changes for users until an admin picks something else. The two id
 * fields stay unset — they only matter for the choices that use them, and an
 * empty id falls back to the start page.
 */

export const version = '091';
export const description = 'Make the home view configurable in ui.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  ctx.setDefault(ui, 'startPage.defaultPage', 'start');

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Applied default home-view setting (startPage.defaultPage)');
}
