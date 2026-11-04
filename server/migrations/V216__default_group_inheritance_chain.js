// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

export const version = '216';
export const description = 'default_group_inheritance_chain';

export async function precondition(ctx) {
  return ctx.fileExists('config/groups.json');
}

/** Whether `fromId` reaches `targetId` by following `inherits` links. */
function reaches(groups, fromId, targetId, seen = new Set()) {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const parents = groups[fromId]?.inherits;
  return Array.isArray(parents) && parents.some(p => reaches(groups, p, targetId, seen));
}

/**
 * Complete the default chain admins → users → authenticated → anonymous.
 * A group that already declares `inherits` (even an empty list) is left alone,
 * and a link that would create a cycle is skipped.
 */
export async function up(ctx) {
  const config = await ctx.readJson('config/groups.json');
  const groups = config.groups;
  if (!groups || typeof groups !== 'object') return;

  const links = [
    ['users', 'authenticated'],
    ['admins', 'users']
  ];
  let changed = false;

  for (const [child, parent] of links) {
    if (!groups[child] || !groups[parent]) continue;
    if (groups[child].inherits !== undefined) continue;
    if (reaches(groups, parent, child)) {
      ctx.warn(`Skipping ${child} → ${parent}: would create a cycle`);
      continue;
    }
    groups[child].inherits = [parent];
    changed = true;
    ctx.log(`${child} now inherits ${parent}`);
  }

  if (changed) await ctx.writeJson('config/groups.json', config);
}
