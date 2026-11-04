// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { PROTECTED_GROUP_IDS } from '../utils/protectedGroups.js';

export const version = '215';
export const description = 'Restore deleted default groups';

export async function precondition(ctx) {
  return ctx.fileExists('config/groups.json');
}

/**
 * Re-add any of the protected default groups (admins, users, anonymous,
 * authenticated) that were deleted. Existing groups are never overwritten.
 */
export async function up(ctx) {
  const config = await ctx.readJson('config/groups.json');
  const defaults = await ctx.readDefaultJson('config/groups.json');

  if (!config.groups || typeof config.groups !== 'object') config.groups = {};

  const restored = [];
  for (const id of PROTECTED_GROUP_IDS) {
    if (!Object.hasOwn(config.groups, id) && defaults?.groups && defaults.groups[id]) {
      config.groups[id] = defaults.groups[id];
      restored.push(id);
    }
  }

  if (restored.length > 0) {
    await ctx.writeJson('config/groups.json', config);
    ctx.log(`Restored default group(s): ${restored.join(', ')}`);
  } else {
    ctx.log('All default groups already present');
  }
}
