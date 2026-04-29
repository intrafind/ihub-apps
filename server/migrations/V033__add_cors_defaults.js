export const version = '033';
export const description = 'add_cors_defaults';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'cors.origin', []);
  ctx.setDefault(platform, 'cors.credentials', true);
  ctx.setDefault(platform, 'cors.maxAge', 86400);
  ctx.setDefault(platform, 'cors.methods', [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'OPTIONS',
    'HEAD',
    'PATCH'
  ]);
  ctx.setDefault(platform, 'cors.allowedHeaders', [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Forwarded-User',
    'X-Forwarded-Groups',
    'Accept',
    'Origin',
    'Cache-Control',
    'X-File-Name'
  ]);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added cors defaults to platform.json');
}
