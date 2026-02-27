/**
 * Migration V012 — Add theme configuration section to ui.json
 *
 * Adds the `theme` top-level section to existing ui.json configs.
 * Provides CSS custom properties for branding and dark mode support.
 */

export const version = '012';
export const description = 'Add theme configuration section to ui.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  // Light mode theme defaults
  ctx.setDefault(ui, 'theme.primaryColor', '#4f46e5');
  ctx.setDefault(ui, 'theme.primaryDark', '#4338ca');
  ctx.setDefault(ui, 'theme.accentColor', '#10b981');
  ctx.setDefault(ui, 'theme.backgroundColor', '#f5f7f8');
  ctx.setDefault(ui, 'theme.surfaceColor', '#ffffff');
  ctx.setDefault(ui, 'theme.textColor', '#1a1a2e');
  ctx.setDefault(ui, 'theme.textMutedColor', '#6b7280');

  // Dark mode theme defaults
  ctx.setDefault(ui, 'theme.darkMode.primaryColor', '#4f46e5');
  ctx.setDefault(ui, 'theme.darkMode.backgroundColor', '#1a1a2e');
  ctx.setDefault(ui, 'theme.darkMode.surfaceColor', '#16213e');
  ctx.setDefault(ui, 'theme.darkMode.textColor', '#f5f5f5');
  ctx.setDefault(ui, 'theme.darkMode.textMutedColor', '#a0a0a0');

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Applied theme configuration defaults');
}
