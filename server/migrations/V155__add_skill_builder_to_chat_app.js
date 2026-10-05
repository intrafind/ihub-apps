/**
 * Migration V155 — Give the Chat app the `skill-builder` skill
 *
 * iHub now ships `skill-builder` (server/defaults/skills/skill-builder/), the
 * marketplace's interview skill that drafts a ready-to-save SKILL.md. Being a
 * default, the skill folder is copied into every installation on startup; this
 * migration assigns it to the shipped Chat app, so the library's "Create skill
 * with AI" has an app to open with `/skill-builder ` in the input. Fresh
 * installs get the assignment from server/defaults/apps/chat.json.
 *
 * Only the `chat` app is touched, and only when it does not list the skill
 * yet; every other skill on it stays as it is. Like every skill, it is only
 * offered with the `skills` feature on and to groups whose `skills`
 * permission grants it. Admins remove it from the app to hide the entry.
 */
export const version = '155';
export const description = 'add_skill_builder_to_chat_app';

const APP_FILE = 'apps/chat.json';

export const SKILL_NAME = 'skill-builder';

export async function precondition(ctx) {
  return await ctx.fileExists(APP_FILE);
}

export async function up(ctx) {
  const app = await ctx.readJson(APP_FILE);
  if (!app || typeof app !== 'object' || Array.isArray(app)) {
    ctx.warn('Chat app is not a JSON object — leaving it unchanged');
    return;
  }

  const skills = Array.isArray(app.skills) ? app.skills : [];
  if (skills.includes(SKILL_NAME)) {
    ctx.log('Chat app already has the skill-builder skill — skipping');
    return;
  }

  app.skills = [...skills, SKILL_NAME];
  await ctx.writeJson(APP_FILE, app);
  ctx.log('Assigned the skill-builder skill to the Chat app');
}
