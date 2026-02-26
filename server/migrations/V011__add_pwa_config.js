/**
 * Migration V011 — Add PWA configuration section to ui.json
 *
 * Adds the `pwa` top-level section to existing ui.json configs.
 * PWA is disabled by default so existing deployments are unaffected
 * until an admin explicitly enables it via Admin > UI Customization > PWA.
 */

export const version = '011';
export const description = 'Add PWA configuration section to ui.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  ctx.setDefault(ui, 'pwa.enabled', false);
  ctx.setDefault(ui, 'pwa.name', 'iHub Apps');
  ctx.setDefault(ui, 'pwa.shortName', 'iHub');
  ctx.setDefault(ui, 'pwa.description', 'AI-powered applications platform');
  ctx.setDefault(ui, 'pwa.themeColor', '#003557');
  ctx.setDefault(ui, 'pwa.backgroundColor', '#ffffff');
  ctx.setDefault(ui, 'pwa.display', 'standalone');
  ctx.setDefault(ui, 'pwa.icons.icon192', '/icons/icon-192.png');
  ctx.setDefault(ui, 'pwa.icons.icon512', '/icons/icon-512.png');
  ctx.setDefault(ui, 'pwa.icons.iconApple', '/icons/icon-192.png');

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Applied pwa defaults');
}
