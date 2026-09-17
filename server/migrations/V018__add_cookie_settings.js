/**
 * Migration V018 — Add cookie settings configuration to platform.json
 *
 * Adds the `cookieSettings` section to platform.json with the `disableSecure` option.
 * This allows administrators to disable the secure flag on cookies for customers
 * running iHub internally without SSL.
 *
 * Default is false (secure cookies enabled in production), which maintains
 * existing behavior and security best practices.
 */

export const version = '018';
export const description = 'Add cookie settings configuration to platform.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Add cookieSettings section with disableSecure defaulting to false
  // This maintains secure cookies in production by default
  ctx.setDefault(platform, 'cookieSettings.disableSecure', false);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added cookieSettings.disableSecure configuration (default: false)');
}
