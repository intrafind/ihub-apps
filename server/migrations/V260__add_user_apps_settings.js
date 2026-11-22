// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V260 — Seed the personal app settings and the two group permissions
 *
 * Personal apps are apps users build themselves, share with roles and
 * publish. They ship dark behind `features.userApps`; this migration only
 * seeds what the feature reads once an admin turns it on:
 *
 * - `platform.userApps` — the limits (apps per user, open ownership offers
 *   per user, the days an owner's stored groups are trusted), the sharing
 *   audiences with the publishing switch (off), what a personal app may use
 *   (model choice and file upload on; web search, skills and connected
 *   systems off), which published apps start switched off, and the list of
 *   blocked owners. Every value is the built-in default, so the upgrade
 *   changes nothing on its own.
 * - `groups.<id>.permissions.userApps` and `.userAppSharing` — who may
 *   create personal apps, and who may share and publish them. The built-in
 *   groups get the value a fresh installation ships with: signed-in users
 *   (`authenticated`, `users`) and `admins` may, `anonymous` may not. Custom
 *   groups are left without it (not allowed), and a value an admin already
 *   set is never touched.
 *
 * Nothing here touches `features.json`: whether personal apps run at all is
 * the admin's call. No app file is read or written.
 */

export const version = '260';
export const description = 'add_user_apps_settings';

export const USER_APP_DEFAULTS = Object.freeze({
  'limits.maxAppsPerUser': 20,
  'limits.maxOpenOffersPerUser': 5,
  'limits.ownerSnapshotMaxAgeDays': 30,
  'sharing.allowUsers': true,
  'sharing.allowGroups': true,
  'sharing.allowEveryone': false,
  'sharing.allowPublish': false,
  'capabilities.modelChoice': true,
  'capabilities.upload': true,
  'capabilities.webSearch': false,
  'capabilities.skills': false,
  'capabilities.integrations': [],
  'publishing.adminEnables': 'withTools',
  blockedOwners: []
});

/** The built-in groups and the permission a fresh installation gives them. */
export const GROUP_DEFAULTS = Object.freeze({
  admins: true,
  users: true,
  authenticated: true,
  anonymous: false
});

const GROUP_PERMISSIONS = Object.freeze(['userApps', 'userAppSharing']);

export async function precondition(ctx) {
  return (
    (await ctx.fileExists('config/platform.json')) || (await ctx.fileExists('config/groups.json'))
  );
}

export async function up(ctx) {
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    let seeded = 0;
    for (const [key, value] of Object.entries(USER_APP_DEFAULTS)) {
      // A fresh array per installation: the frozen default must not be shared.
      const fresh = Array.isArray(value) ? [...value] : value;
      if (ctx.setDefault(platform, `userApps.${key}`, fresh)) seeded++;
    }
    if (seeded > 0) {
      await ctx.writeJson('config/platform.json', platform);
      ctx.log(`Seeded ${seeded} platform.userApps defaults`);
    } else {
      ctx.log('platform.userApps is complete — no changes needed');
    }
  }

  if (await ctx.fileExists('config/groups.json')) {
    const config = await ctx.readJson('config/groups.json');
    if (!config.groups || typeof config.groups !== 'object') {
      ctx.warn('groups.json has no groups object — skipping the personal app permissions');
      return;
    }
    let updated = 0;
    for (const [groupId, value] of Object.entries(GROUP_DEFAULTS)) {
      const group = config.groups[groupId];
      if (!group || typeof group !== 'object') continue;
      if (!group.permissions || typeof group.permissions !== 'object') group.permissions = {};
      for (const permission of GROUP_PERMISSIONS) {
        if (group.permissions[permission] !== undefined) continue;
        group.permissions[permission] = value;
        updated++;
        ctx.log(`Set ${permission}=${value} on group "${groupId}"`);
      }
    }
    if (updated > 0) {
      await ctx.writeJson('config/groups.json', config);
    } else {
      ctx.log('Built-in groups already carry the personal app permissions — no changes needed');
    }
  }
}
