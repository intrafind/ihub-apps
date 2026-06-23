export const version = '062';
export const description = 'add_ssrf_allowed_hosts';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'ssrf.allowedHosts', []);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added ssrf.allowedHosts default to platform.json');
}
