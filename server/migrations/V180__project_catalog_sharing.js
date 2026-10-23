// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V180 — Project catalog
 *
 * Owners and editors may publish a user project to a catalog that every
 * signed-in user can browse and add from, when an admin allows it. This writes
 * that switch, off, next to the other project sharing audiences so the admin
 * Projects page shows it.
 */

export const version = '180';
export const description = 'project_catalog_sharing';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'projects.sharing.allowCatalog', false);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Publishing projects to the catalog is off (projects.sharing.allowCatalog: false)');
}
