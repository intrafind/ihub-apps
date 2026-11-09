// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V237 — Default refresh TTL of project items (#3536)
 *
 * Adds `platform.projects.refreshTtl` (86 400 seconds, a day): how long a
 * file downloaded from a website is kept before it is downloaded again, and
 * how long a web page's read is cached. Projects and items may set their
 * own. An existing value is kept; a platform.json without a `projects`
 * block gets none (the built-in default applies).
 */

export const version = '237';
export const description = 'project_refresh_ttl';

export const DEFAULT_REFRESH_TTL_SECONDS = 86400;

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const projects = platform?.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    ctx.log('No platform.projects — the built-in refresh TTL applies');
    return;
  }
  if (projects.refreshTtl !== undefined) {
    ctx.log('platform.projects.refreshTtl is set already — left as it is');
    return;
  }
  projects.refreshTtl = DEFAULT_REFRESH_TTL_SECONDS;
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Set platform.projects.refreshTtl=${DEFAULT_REFRESH_TTL_SECONDS}`);
}
