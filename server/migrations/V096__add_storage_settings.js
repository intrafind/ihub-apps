/**
 * Migration V096 — Seed the platform `storage` section
 *
 * iHub now has a storage abstraction (documents, append-logs, locks and change
 * events) behind a pluggable provider. Only the filesystem provider ships, and
 * it is the default, so seeding these settings changes no behaviour on an
 * upgrade — it writes down what the server already does.
 *
 * They are seeded so the section is visible and editable in Admin → Platform
 * Configuration from the first upgrade, instead of appearing out of nowhere
 * when a later release registers a second provider:
 *
 * - `storage.provider`                    — which provider backs runtime data.
 * - `storage.filesystem.dataDir`          — directory under contents/ for that data.
 * - `storage.filesystem.flushIntervalMs`  — debounce for buffered append-log writes.
 *
 * Every value seeded here is the built-in default, so behaviour is unchanged.
 * `setDefault` never overwrites an admin's own choice — an installation that
 * already names a provider (or was pre-configured for one a later release will
 * register) keeps it.
 */

export const version = '096';
export const description = 'add_storage_settings';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'storage.provider', 'filesystem');
  ctx.setDefault(platform, 'storage.filesystem.dataDir', 'data');
  ctx.setDefault(platform, 'storage.filesystem.flushIntervalMs', 2000);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added storage defaults (provider=filesystem, dataDir=data, flushIntervalMs=2000)');
}
