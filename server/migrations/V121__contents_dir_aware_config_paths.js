/**
 * Migration V121 — Let the users, OAuth client and skills paths follow CONTENTS_DIR
 *
 * `localAuth.usersFile`, `oauth.clientsFile` and `skills.skillsDirectory` are
 * paths relative to the installation root, and platform.json shipped them
 * spelled out as `contents/config/users.json`,
 * `contents/config/oauth-clients.json` and `contents/skills`. On an
 * installation that sets `CONTENTS_DIR`, that spelled-out `contents/` pointed
 * sign-in, token checks and skill loading at a directory the rest of the server
 * does not use, while the admin pages saved into the configured one — so a
 * user created in the admin UI could not sign in, and an uploaded skill never
 * loaded.
 *
 * With the setting absent the server applies a default built from
 * `CONTENTS_DIR`. This migration removes the settings only where they still
 * hold the shipped value, which is the same location as that default on an
 * installation that kept the name `contents`, so nothing moves there. A value
 * an admin chose is left alone.
 */

export const version = '121';
export const description = 'Drop shipped users/clients/skills paths so they follow CONTENTS_DIR';

// The values platform.json shipped with. Repeated here rather than imported —
// migrations must be self-contained.
const SHIPPED_PATHS = [
  ['localAuth.usersFile', 'contents/config/users.json'],
  ['oauth.clientsFile', 'contents/config/oauth-clients.json'],
  ['skills.skillsDirectory', 'contents/skills']
];

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  const removed = [];
  for (const [dotPath, shipped] of SHIPPED_PATHS) {
    const [section, key] = dotPath.split('.');
    if (platform[section]?.[key] === shipped) {
      delete platform[section][key];
      removed.push(dotPath);
    }
  }

  if (removed.length === 0) {
    ctx.log('No shipped users/clients/skills paths in platform.json — nothing to do');
    return;
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Removed shipped ${removed.join(', ')} so the default follows CONTENTS_DIR`);
}
