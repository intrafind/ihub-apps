export const version = '027';
export const description = 'add_ifinder_oidc_keypair';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Add useOidcKeyPair flag (default false - backward compatible)
  ctx.setDefault(platform, 'iFinder.useOidcKeyPair', false);

  // Remove iAssistant.baseUrl - iAssistant always runs on the same host as iFinder
  if (platform.iAssistant && 'baseUrl' in platform.iAssistant) {
    ctx.removeKey(platform, 'iAssistant.baseUrl');
    ctx.log('Removed iAssistant.baseUrl (iAssistant always uses iFinder.baseUrl)');
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added iFinder.useOidcKeyPair default (false)');
}
