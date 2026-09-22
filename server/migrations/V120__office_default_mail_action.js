/**
 * Migration V120 — Add the Outlook add-in's default answer action
 *
 * The task pane's answer buttons were reworked into five distinct actions, one
 * per Office.js call — reply, reply all, forward, new email, and insert into
 * the open draft (issue #2446). Which one the main button runs is now
 * configurable under Admin → Office Integration → Answer Actions, through a
 * new `defaultMailAction` field in the `officeIntegration` section of
 * platform.json, and each user may override it in the task pane's Settings
 * dialog.
 *
 * Seeded as `auto` — follow the open item: reply all when an email is selected
 * in the reading pane (so no recipient of a thread is dropped), insert while
 * the user is already composing. That is what the pane does with no setting at
 * all, so this migration changes no behaviour; it writes the field so admins
 * find it where the other add-in settings live. Only a missing value is
 * written, so an already-configured choice is preserved. Installations without
 * an `officeIntegration` block have never enabled the add-in and are left
 * alone — the pane falls back to the same default if it is ever turned on.
 */

export const version = '120';
export const description = 'Add the default answer action to officeIntegration';

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

  if (!ctx.setDefault(platform, 'officeIntegration.defaultMailAction', 'auto')) {
    ctx.log('Outlook add-in default answer action already present — nothing to do');
    return;
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Applied Outlook add-in default answer action (defaultMailAction=auto)');
}
