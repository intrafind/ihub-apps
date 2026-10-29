// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V185 — Settings for in-place updates of binary installations (#2971)
 *
 * Updates are now verified against an Ed25519 signature, and an admin can
 * install a release archive from a file (air-gapped installations). This
 * writes the defaults of the new `update` section so they are visible and
 * editable in platform.json:
 *
 *  - `allowUnsigned: false` — archives that are not signed by a trusted key
 *    are refused
 *  - `trustedPublicKeys: []` — keys trusted in addition to the release keys
 *    built into iHub (for installations that build their own binaries)
 *  - `maxUploadSizeMB: 1024` — largest archive the browser upload accepts
 */

export const version = '185';
export const description = 'update_settings';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'update.allowUnsigned', false);
  ctx.setDefault(platform, 'update.trustedPublicKeys', []);
  ctx.setDefault(platform, 'update.maxUploadSizeMB', 1024);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Added update settings (allowUnsigned: false, trustedPublicKeys: [], maxUploadSizeMB: 1024)'
  );
}
