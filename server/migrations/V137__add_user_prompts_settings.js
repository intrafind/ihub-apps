/**
 * Migration V137 — Seed the platform `userPrompts` section
 *
 * The prompt library lets signed-in users keep prompts of their own and share
 * them (#2519). These are the settings it reads, and what
 * Admin → Prompts → User prompts edits:
 *
 * - `userPrompts.enabled`                  — users may keep their own prompts.
 * - `userPrompts.maxPromptsPerUser`        — most prompts one user may keep;
 *                                            <= 0 means no limit.
 * - `userPrompts.maxVersions`              — revisions kept per prompt.
 * - `userPrompts.sharing.allowUsers`       — share with named users.
 * - `userPrompts.sharing.allowGroups`      — share with groups.
 * - `userPrompts.sharing.allowEveryone`    — share with everyone signed in.
 * - `userPrompts.sharing.restrictToGroups` — when it names groups, only their
 *                                            members may share with groups or
 *                                            with everyone.
 *
 * Every value is the built-in default, so an upgrade changes nothing on its
 * own — the section just becomes visible and editable.
 */

export const version = '137';
export const description = 'add_user_prompts_settings';

export const USER_PROMPTS_DEFAULTS = Object.freeze({
  enabled: true,
  maxPromptsPerUser: 0,
  maxVersions: 50,
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

  for (const [key, value] of Object.entries(USER_PROMPTS_DEFAULTS)) {
    ctx.setDefault(platform, `userPrompts.${key}`, Array.isArray(value) ? [...value] : value);
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Added userPrompts defaults (enabled=true, maxPromptsPerUser=0, maxVersions=50, ' +
      'sharing: users, groups and everyone allowed, restrictToGroups=[])'
  );
}
