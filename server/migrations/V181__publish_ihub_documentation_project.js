// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V181 — Publish the iHub documentation project
 *
 * Documents can be linked into a project only from the caller's own projects
 * and published ones. Admin projects can now be published (`published: true`):
 * everyone signed in may then use them and link their documents. The shipped
 * iHub documentation project is published, so users keep linking it. An admin
 * who already set the switch keeps their choice.
 */

const PROJECT_FILE = 'projects/ihub-documentation.json';

export const version = '181';
export const description = 'publish_ihub_documentation_project';

export async function precondition(ctx) {
  return await ctx.fileExists(PROJECT_FILE);
}

export async function up(ctx) {
  const project = await ctx.readJson(PROJECT_FILE);
  ctx.setDefault(project, 'published', true);
  await ctx.writeJson(PROJECT_FILE, project);
  ctx.log('The iHub documentation project is published (published: true)');
}
