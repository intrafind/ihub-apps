// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V190 — ZIP limits of the artifact store (#3055)
 *
 * A chat's artifacts can now be downloaded as one ZIP archive, and the
 * `create_zip` tool of the `files` system skill builds one on request. Two
 * settings bound what one archive may pack:
 *
 * - `artifacts.maxZipFiles` — files in one archive; <= 0 removes the cap.
 * - `artifacts.maxZipBytes` — bytes of content in one archive, before
 *                             compression; <= 0 removes the cap.
 *
 * Both are the built-in defaults, so an upgrade changes nothing on its own;
 * the keys just become visible and editable in Admin → Platform Configuration.
 * Values an installation already set are kept.
 */

export const version = '190';
export const description = 'add_artifact_zip_limits';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'artifacts.maxZipFiles', 200);
  ctx.setDefault(platform, 'artifacts.maxZipBytes', 104857600);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added artifact ZIP limits (maxZipFiles=200, maxZipBytes=104857600)');
}
