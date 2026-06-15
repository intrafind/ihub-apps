/**
 * Migration V057 — Add favicon configuration to ui.json header
 *
 * Adds an admin-configurable `header.favicon` field so the browser favicon can be
 * branded without patching index.html. Defaults to the existing static favicon, so
 * behavior is unchanged for existing installations.
 */

export const version = '057';
export const description = 'Add header.favicon to ui.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  ctx.setDefault(ui, 'header.favicon', '/favicon.ico');

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Applied header.favicon default');
}
