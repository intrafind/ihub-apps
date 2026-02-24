/**
 * Migration V006 — Add iHub Official Marketplace registry
 *
 * Adds the official iHub marketplace registry to config/registries.json
 * if it is not already present. This gives all existing installations
 * access to the curated collection of apps, models, workflows, prompts,
 * and skills out of the box.
 *
 * Fresh installs receive this automatically via server/defaults/config/registries.json.
 */

export const version = '006';
export const description = 'Add iHub Official Marketplace registry';

export async function precondition(ctx) {
  return await ctx.fileExists('config/registries.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/registries.json');

  if (!Array.isArray(config.registries)) {
    config.registries = [];
  }

  const added = ctx.addIfMissing(
    config.registries,
    {
      id: 'ihub-official',
      name: 'iHub Official Marketplace',
      description:
        'Official collection of apps, models, workflows, prompts, and skills for iHub Apps',
      source: 'https://raw.githubusercontent.com/intrafind/ihub-marketplace/main/catalog.json',
      auth: { type: 'none' },
      enabled: true,
      autoRefresh: false,
      refreshIntervalHours: 24
    },
    'id'
  );

  if (added) {
    await ctx.writeJson('config/registries.json', config);
    ctx.log('Added iHub Official Marketplace registry');
  } else {
    ctx.log('iHub Official Marketplace registry already present — skipping');
  }
}
