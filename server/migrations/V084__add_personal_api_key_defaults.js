export const version = '084';
export const description = 'add_personal_api_key_defaults';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Seed defaults for user-managed personal API keys
 * (platform.oauth.personalKeys) so the section exists with explicit values and
 * renders in the admin UI. The feature stays off until an administrator turns
 * it on, and setDefault never overwrites anything already configured.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'oauth.personalKeys.enabled', false);
  // Empty means every signed-in user may create keys once the feature is on.
  ctx.setDefault(platform, 'oauth.personalKeys.allowedGroups', []);
  ctx.setDefault(platform, 'oauth.personalKeys.maxKeysPerUser', 5);
  ctx.setDefault(platform, 'oauth.personalKeys.defaultExpirationDays', 90);
  ctx.setDefault(platform, 'oauth.personalKeys.maxExpirationDays', 365);
  ctx.setDefault(platform, 'oauth.personalKeys.allowClientCredentials', true);
  // Empty means fall back to mcpServer.defaultScopes at runtime.
  ctx.setDefault(platform, 'oauth.personalKeys.scopes', []);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added oauth.personalKeys defaults');
}
