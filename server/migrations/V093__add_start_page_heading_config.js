/**
 * Migration V093 — Make the start-page heading configurable in ui.json
 *
 * The start page greets users by name ("Good morning, Ada!"). Installations
 * whose directory has no presentable names can now turn the name off, or
 * replace the heading altogether, through two fields in the `startPage`
 * section of ui.json (Admin → UI Customization → Start Page):
 *
 * - `showUserName` — include the viewer's name in the heading.
 * - `title`        — localized heading that replaces the built-in greeting,
 *                    with `{{greeting}}` and `{{name}}` placeholders.
 *
 * Only `showUserName` is seeded, with the behaviour installs already have, so
 * nothing changes on screen until an admin turns it off. `title` stays unset
 * on purpose: an unset heading uses the bundled greeting translations, which
 * cover every UI language, while a seeded one would pin the heading to the
 * languages written here.
 */

export const version = '093';
export const description = 'Make the start-page heading configurable in ui.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  ctx.setDefault(ui, 'startPage.showUserName', true);

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Applied start-page heading setting (startPage.showUserName)');
}
