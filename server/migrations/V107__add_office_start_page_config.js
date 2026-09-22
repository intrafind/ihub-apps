/**
 * Migration V107 — Add start-page settings to the Outlook add-in config
 *
 * The Outlook task pane used to land on the plain apps list after sign-in.
 * It now opens a start page like the web app's: a greeting, the default app's
 * chat input with the open email (and any collected emails) as context, and a
 * few app shortcuts — so a user can pick up a couple of emails and answer them
 * without choosing an app first. Admins configure it under Admin → Office
 * Integration → Start Page, through a new `startPage` block in the
 * `officeIntegration` section of platform.json:
 *
 * - `defaultPage`    — `start` (the start page) or `apps` (the apps list, the
 *                      previous behaviour).
 * - `defaultAppId`   — the app whose chat input the start page shows; unset
 *                      means the top-ranked chat app the user can access (not
 *                      seeded on purpose, so the automatic choice applies).
 * - `featuredAppIds` — the default apps, shown in this order right after each
 *                      user's favorites.
 *
 * `defaultPage` is seeded as `start` — the start page is the point of the
 * feature — so upgraded installations get the same landing view as fresh
 * ones; admins who prefer the apps list switch it back with one click. Only
 * missing values are written, so anything an admin has already configured is
 * preserved. Installations without an `officeIntegration` block have never
 * enabled the add-in; they are left alone and the pane falls back to the
 * same built-in defaults if it is ever turned on.
 */

export const version = '107';
export const description = 'Add start-page settings to officeIntegration';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  const office = platform.officeIntegration;
  if (!office || typeof office !== 'object' || Array.isArray(office)) {
    ctx.log('No officeIntegration block in platform.json — nothing to seed');
    return;
  }

  const changed = [
    ctx.setDefault(platform, 'officeIntegration.startPage.defaultPage', 'start'),
    ctx.setDefault(platform, 'officeIntegration.startPage.featuredAppIds', [])
  ].some(Boolean);

  if (!changed) {
    ctx.log('Outlook add-in start-page settings already present — nothing to do');
    return;
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Applied Outlook add-in start-page defaults (startPage.defaultPage=start, featuredAppIds=[])'
  );
}
