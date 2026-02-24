/**
 * Migration V005 — Add Marketplace feature
 *
 * Creates the two configuration files required by the marketplace feature:
 * - config/registries.json  — stores the list of configured content registries
 * - config/installations.json — tracks which marketplace items are installed
 *
 * Both files are only created if they do not already exist so that data
 * from a previous installation is never overwritten.
 */

export const version = '005';
export const description = 'Add marketplace feature';

export async function up(ctx) {
  // Ensure registries.json exists
  if (!(await ctx.fileExists('config/registries.json'))) {
    const defaults = await ctx.readDefaultJson('config/registries.json');
    await ctx.writeJson('config/registries.json', defaults);
    ctx.log('Created config/registries.json');
  } else {
    ctx.log('config/registries.json already exists — skipping');
  }

  // Ensure installations.json exists
  if (!(await ctx.fileExists('config/installations.json'))) {
    const defaults = await ctx.readDefaultJson('config/installations.json');
    await ctx.writeJson('config/installations.json', defaults);
    ctx.log('Created config/installations.json');
  } else {
    ctx.log('config/installations.json already exists — skipping');
  }
}
