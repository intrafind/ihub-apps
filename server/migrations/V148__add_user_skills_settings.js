/**
 * Migration V148 — Seed the platform `userSkills` section
 *
 * Signed-in users can keep skills of their own and share them, the same way
 * they keep prompts. These are the settings it reads, and what
 * Admin → Skills → User skills edits:
 *
 * - `userSkills.enabled`                  — users may keep their own skills.
 * - `userSkills.maxSkillsPerUser`         — most skills one user may keep;
 *                                           <= 0 means no limit.
 * - `userSkills.maxVersions`              — revisions kept per skill.
 * - `userSkills.maxSkillSizeKB`           — instructions and files together.
 * - `userSkills.maxFilesPerSkill`         — reference files per skill.
 * - `userSkills.sharing.allowUsers`       — share with named users.
 * - `userSkills.sharing.allowGroups`      — share with groups.
 * - `userSkills.sharing.allowEveryone`    — share with everyone signed in.
 * - `userSkills.sharing.restrictToGroups` — when it names groups, only their
 *                                           members may share with groups or
 *                                           with everyone.
 *
 * Every value is the built-in default, so an upgrade changes nothing on its
 * own — the section just becomes visible and editable. User skills only take
 * effect while the `skills` feature is on.
 */

export const version = '148';
export const description = 'add_user_skills_settings';

export const USER_SKILLS_DEFAULTS = Object.freeze({
  enabled: true,
  maxSkillsPerUser: 50,
  maxVersions: 50,
  maxSkillSizeKB: 256,
  maxFilesPerSkill: 20,
  'sharing.allowUsers': true,
  'sharing.allowGroups': true,
  'sharing.allowEveryone': true,
  'sharing.restrictToGroups': []
});

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  for (const [key, value] of Object.entries(USER_SKILLS_DEFAULTS)) {
    ctx.setDefault(platform, `userSkills.${key}`, Array.isArray(value) ? [...value] : value);
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Added userSkills defaults (enabled=true, maxSkillsPerUser=50, maxVersions=50, ' +
      'maxSkillSizeKB=256, maxFilesPerSkill=20, sharing: users, groups and everyone allowed, ' +
      'restrictToGroups=[])'
  );
}
