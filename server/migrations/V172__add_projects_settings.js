// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V172 — Seed the projects settings and the two group permissions
 *
 * Projects (#1036) are the one container for documents, instructions and
 * chats. User projects ship dark behind `features.userProjects`; this
 * migration only seeds what the feature reads once an admin turns it on:
 *
 * - `platform.projects` — the tier policy, the limits of the local tier
 *   (files per project, bytes per file and per project, projects per user),
 *   the sharing audiences, retention, the load-all budget, the item kind
 *   switches and the key provider. Every value is the built-in default, so
 *   the upgrade changes nothing on its own.
 * - `groups.<id>.permissions.projects` and `.projectSharing` — who may
 *   create user projects and share them. The built-in groups get the value a
 *   fresh installation ships with: signed-in users (`authenticated`, `users`)
 *   and `admins` may, `anonymous` may not. Custom groups are left without it
 *   (not allowed), and a value an admin already set is never touched.
 *
 * Nothing here touches `features.json` or `config/sources.json`: whether
 * user projects run at all is the admin's call, and the fold of sources into
 * admin projects is its own migration.
 */

export const version = '172';
export const description = 'add_projects_settings';

export const PROJECT_DEFAULTS = Object.freeze({
  tierPolicy: 'ihub',
  'limits.maxFiles': 25,
  'limits.maxFileBytes': 20971520,
  'limits.maxProjectBytes': 209715200,
  'limits.maxProjectsPerUser': 20,
  'sharing.allowUsers': true,
  'sharing.allowGroups': true,
  'sharing.allowEveryone': false,
  retentionDays: 0,
  loadAllMaxTokens: 50000,
  kinds: {},
  'encryption.keyProvider': 'local-file'
});

/** The built-in groups and the permission a fresh installation gives them. */
export const GROUP_DEFAULTS = Object.freeze({
  admins: true,
  users: true,
  authenticated: true,
  anonymous: false
});

export async function precondition(ctx) {
  return (
    (await ctx.fileExists('config/platform.json')) || (await ctx.fileExists('config/groups.json'))
  );
}

export async function up(ctx) {
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    for (const [key, value] of Object.entries(PROJECT_DEFAULTS)) {
      ctx.setDefault(platform, `projects.${key}`, value);
    }
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Seeded platform.projects defaults');
  }

  if (await ctx.fileExists('config/groups.json')) {
    const config = await ctx.readJson('config/groups.json');
    if (!config.groups || typeof config.groups !== 'object') {
      ctx.warn('groups.json has no groups object — skipping the projects permissions');
      return;
    }
    let updated = 0;
    for (const [groupId, value] of Object.entries(GROUP_DEFAULTS)) {
      const group = config.groups[groupId];
      if (!group || typeof group !== 'object') continue;
      if (!group.permissions || typeof group.permissions !== 'object') group.permissions = {};
      for (const permission of ['projects', 'projectSharing']) {
        if (group.permissions[permission] !== undefined) continue;
        group.permissions[permission] = value;
        updated++;
        ctx.log(`Set ${permission}=${value} on group "${groupId}"`);
      }
    }
    if (updated > 0) {
      await ctx.writeJson('config/groups.json', config);
    } else {
      ctx.log('Built-in groups already carry the projects permissions — no changes needed');
    }
  }
}
