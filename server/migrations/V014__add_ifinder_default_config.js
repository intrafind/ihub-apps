export const version = '014';
export const description = 'add_ifinder_default_config';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'iFinder', {
    enabled: false,
    baseUrl: '',
    privateKey: '',
    algorithm: 'RS256',
    issuer: 'ihub-apps',
    audience: 'ifinder-api',
    tokenExpirationSeconds: 3600,
    defaultScope: 'fa_index_read'
  });

  ctx.setDefault(platform, 'iAssistant', {
    baseUrl: '',
    defaultProfileId: '',
    timeout: 60000
  });

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added iFinder and iAssistant default configuration');
}
