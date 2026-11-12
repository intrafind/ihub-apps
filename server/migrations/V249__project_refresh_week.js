// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V249 — Project items are refreshed after a week by default (#3622)
 *
 * The default refresh TTL of files from websites and web pages goes from a
 * day to a week. V237 wrote the day into `platform.projects.refreshTtl` before
 * the feature was released, so the day found there is that default, not an
 * administrator's choice: it becomes the week. Any other value is kept.
 */

export const version = '249';
export const description = 'project_refresh_week';

export const PREVIOUS_DEFAULT_SECONDS = 86400;
export const DEFAULT_REFRESH_TTL_SECONDS = 604800;

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
  if (projects.refreshTtl !== PREVIOUS_DEFAULT_SECONDS) {
    ctx.log('platform.projects.refreshTtl is not the previous default — left as it is');
    return;
  }
  projects.refreshTtl = DEFAULT_REFRESH_TTL_SECONDS;
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Set platform.projects.refreshTtl=${DEFAULT_REFRESH_TTL_SECONDS}`);
}
