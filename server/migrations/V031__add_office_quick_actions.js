export const version = '031';
export const description = 'add_office_quick_actions';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'officeIntegration.quickActions', []);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added officeIntegration.quickActions default');
}
