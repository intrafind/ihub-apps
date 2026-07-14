export const version = '078';
export const description = 'add_database_settings';

// Seeds the platform.json `database` block used by the new StorageProvider
// abstraction (server/persistence/). Filesystem stays the default backend;
// PostgreSQL only activates when DATABASE_URL is set (or this block is later
// switched on via the admin UI, once that ships).
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  const changed = ctx.setDefault(platform, 'database.enabled', false);

  if (changed) {
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Added database.enabled default (false) to platform.json');
  } else {
    ctx.log('database.enabled already present; no change needed');
  }
}
