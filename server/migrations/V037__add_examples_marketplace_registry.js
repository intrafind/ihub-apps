/**
 * Migration V037 — Add iHub Examples marketplace registry
 *
 * Adds the in-repo example marketplace to config/registries.json so admins
 * can browse and install example models, apps, and prompts shipped under
 * the repository's `examples/` folder. The registry catalog is fetched
 * from raw.githubusercontent.com (same path used by ihub-official).
 *
 * Fresh installs receive this automatically via
 * server/defaults/config/registries.json.
 */

export const version = '037';
export const description = 'add_examples_marketplace_registry';

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
      id: 'ihub-examples',
      name: 'iHub Examples',
      description: 'In-repo example apps, models, prompts, and skills shipped with iHub Apps',
      source: 'https://raw.githubusercontent.com/intrafind/ihub-apps/main/examples/catalog.json',
      auth: { type: 'none' },
      enabled: true,
      autoRefresh: false,
      refreshIntervalHours: 24
    },
    'id'
  );

  if (added) {
    await ctx.writeJson('config/registries.json', config);
    ctx.log('Added iHub Examples marketplace registry');
  } else {
    ctx.log('iHub Examples marketplace registry already present — skipping');
  }
}
