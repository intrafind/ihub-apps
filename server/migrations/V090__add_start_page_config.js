/**
 * Migration V090 — Add start-page section to ui.json
 *
 * The user-facing "/" route is now a personalized start page (greeting, the
 * default app's chat input, featured apps) instead of the apps list, which
 * moved to "/apps". Its behaviour is configured in a new `startPage` section
 * of ui.json, editable under Admin → UI Customization → Start Page:
 *
 * - `showDefaultApp` — whether the chat input of the default app is shown.
 * - `defaultAppId`   — the app whose chat input is shown; when unset the first
 *                       app the user can access is used (not seeded here on
 *                       purpose, so the automatic choice stays in effect).
 * - `subtitle`       — localized line under the greeting.
 *
 * Every value is only added when missing, so anything an admin has already
 * configured is preserved. The start page falls back to its bundled i18n
 * strings for any unset field, so this migration does not change what users
 * see — it just exposes the defaults for editing.
 */

export const version = '090';
export const description = 'Add start-page section to ui.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  ctx.setDefault(ui, 'startPage.showDefaultApp', true);
  ctx.setDefault(ui, 'startPage.subtitle', {
    en: 'How can I help you today?',
    de: 'Wie kann ich Ihnen heute helfen?'
  });

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Applied start-page defaults');
}
