export const version = '002';
export const description = 'Ensure default providers are present';

/**
 * Only run if the providers config file exists.
 * If it doesn't exist, performInitialSetup() will have copied the default.
 */
export async function precondition(ctx) {
  return ctx.fileExists('config/providers.json');
}

/**
 * Ensure all default providers from server/defaults/config/providers.json
 * are present in the user's contents/config/providers.json.
 * Replaces the ad-hoc ensureDefaultProviders() from providerMigration.js.
 */
export async function up(ctx) {
  const providersConfig = await ctx.readJson('config/providers.json');
  const defaultsConfig = await ctx.readDefaultJson('config/providers.json');

  const existingIds = new Set(providersConfig.providers.map(p => p.id));
  const missing = defaultsConfig.providers.filter(p => !existingIds.has(p.id));

  if (missing.length > 0) {
    providersConfig.providers.push(...missing);
    await ctx.writeJson('config/providers.json', providersConfig);
    ctx.log(`Added ${missing.length} missing provider(s): ${missing.map(p => p.id).join(', ')}`);
  } else {
    ctx.log('All default providers already present');
  }
}
