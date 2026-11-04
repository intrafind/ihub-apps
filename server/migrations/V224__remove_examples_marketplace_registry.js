// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V224 — Remove the iHub Examples marketplace registry
 *
 * V037 added the `ihub-examples` registry, whose catalog was the `examples/`
 * folder of this repository served from raw.githubusercontent.com. That folder
 * is gone: what was in it now lives in the iHub Official Marketplace
 * (intrafind/ihub-marketplace), so the registry's URL would answer 404.
 *
 * Only the entry V037 added is removed: id `ihub-examples` AND the exact
 * source URL. A registry an admin added or edited (another id, or the same id
 * pointing elsewhere) is left alone.
 *
 * Items installed from that registry stay as they are. Their files in
 * `apps/`, `models/` and `prompts/` and their entries in
 * `config/installations.json` are not touched, so they keep working and can be
 * uninstalled or detached. Without the registry the update check skips them
 * (it only compares items whose registry has a cached catalog).
 *
 * The cached catalog `.registry-cache/ihub-examples.json` is deleted with the
 * registry, as the admin UI does when it removes one.
 */

export const version = '224';
export const description = 'remove_examples_marketplace_registry';

const REGISTRIES_FILE = 'config/registries.json';
const REGISTRY_ID = 'ihub-examples';
const REGISTRY_SOURCE =
  'https://raw.githubusercontent.com/intrafind/ihub-apps/main/examples/catalog.json';
const CACHE_FILE = '.registry-cache/ihub-examples.json';

export async function precondition(ctx) {
  return ctx.fileExists(REGISTRIES_FILE);
}

export async function up(ctx) {
  const config = await ctx.readJson(REGISTRIES_FILE);
  if (!Array.isArray(config?.registries)) return;

  const kept = config.registries.filter(
    registry => !(registry?.id === REGISTRY_ID && registry?.source === REGISTRY_SOURCE)
  );
  if (kept.length === config.registries.length) {
    ctx.log('iHub Examples marketplace registry not present (or changed by an admin) — skipping');
    return;
  }

  config.registries = kept;
  await ctx.writeJson(REGISTRIES_FILE, config);
  if (await ctx.fileExists(CACHE_FILE)) {
    await ctx.deleteFile(CACHE_FILE);
  }
  ctx.log('Removed iHub Examples marketplace registry');
}
