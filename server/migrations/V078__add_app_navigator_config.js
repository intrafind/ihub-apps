export const version = '078';
export const description = 'add_app_navigator_config';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  ctx.setDefault(ui, 'appNavigator.enabled', true);
  ctx.setDefault(ui, 'appNavigator.categoryOrder', []);

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Added appNavigator defaults (enabled=true, categoryOrder=[])');
}
