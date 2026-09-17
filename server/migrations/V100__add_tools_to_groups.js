/**
 * Migration V100 — Add tools permissions to groups
 *
 * Tool visibility on the MCP/A2A gateways used to be derived purely from the
 * apps a caller could access, so exposing a tool (iFinder, Jira, ...) directly
 * over MCP meant enabling a carrier app whose only job was to hold the
 * permission. Groups now carry an explicit `tools` list.
 *
 * Every group gets `tools: []` — deny by default. Unlike V004 (skills), a
 * wildcard default would be a privilege escalation: a direct tool grant lets an
 * MCP client call integrations like iFinder, Jira and Entra as the user,
 * without an app mediating the call. Operators opt in per group.
 *
 * Groups that already define `tools` are left alone.
 */

export const version = '100';
export const description = 'Add tools permissions to groups';

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

    if (group.permissions.tools !== undefined) {
      ctx.log(`Group "${groupId}" already has tools permissions — skipping`);
      continue;
    }

    group.permissions.tools = [];
    updated++;
    ctx.log(`Added empty tools permissions to group "${groupId}"`);
  }

  if (updated > 0) {
    await ctx.writeJson('config/groups.json', config);
    ctx.log(`Updated ${updated} group(s) with tools permissions`);
  } else {
    ctx.log('All groups already have tools permissions — no changes needed');
  }
}
