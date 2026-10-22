// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

export const version = '176';
export const description = 'add_setup_disabled_flag';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'setup.disabled', false);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added setup.disabled = false');
}
