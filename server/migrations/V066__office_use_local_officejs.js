export const version = '066';
export const description = 'office_use_local_officejs';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'officeIntegration.useLocalOfficejs', false);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added officeIntegration.useLocalOfficejs default (false)');
}
