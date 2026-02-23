/**
 * Migration V004 — Add skills permissions to groups
 *
 * The V003 migration added the `skills` feature flag and platform config,
 * but did NOT add `skills` permissions to existing groups in groups.json.
 * Without skills permissions, `getSkillsForUser()` filters out all skills
 * because `filterResourcesByPermissions()` receives an empty Set.
 *
 * This migration adds `skills` permissions to every group:
 * - `anonymous` → skills: []  (no skills for anonymous users)
 * - All other groups → skills: ["*"]  (generous default for new feature)
 * - Groups that already have `skills` defined are skipped.
 */

export const version = '004';
export const description = 'Add skills permissions to groups';

export async function precondition(ctx) {
  return await ctx.fileExists('config/groups.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/groups.json');

  if (!config.groups || typeof config.groups !== 'object') {
    ctx.warn('groups.json has no groups object — skipping');
    return;
  }

  let updated = 0;

  for (const [groupId, group] of Object.entries(config.groups)) {
    if (!group.permissions) continue;

    // Skip groups that already have skills defined
    if (group.permissions.skills !== undefined) {
      ctx.log(`Group "${groupId}" already has skills permissions — skipping`);
      continue;
    }

    // Anonymous gets empty skills, everyone else gets wildcard
    group.permissions.skills = groupId === 'anonymous' ? [] : ['*'];
    updated++;
    ctx.log(
      `Added skills permissions to group "${groupId}": ${JSON.stringify(group.permissions.skills)}`
    );
  }

  if (updated > 0) {
    await ctx.writeJson('config/groups.json', config);
    ctx.log(`Updated ${updated} group(s) with skills permissions`);
  } else {
    ctx.log('All groups already have skills permissions — no changes needed');
  }
}
