// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V246 — who a provenance record names (EU AI Act Art. 50(2))
 *
 * `provenance.recordUser` decides whether a stored provenance record names the
 * user who produced the output: `none` (nobody, as before), `anonymous` (a
 * fingerprint of the user), `pseudonymous` (a fingerprint of the conversation)
 * or `identified` (the user id). Seeded as `none` so nothing changes on upgrade
 * and the key is visible; a value an installation already set is kept.
 */

export const version = '246';
export const description = 'add_provenance_record_user';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'provenance.recordUser', 'none');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('provenance.recordUser defaults to "none" (records name nobody)');
}
