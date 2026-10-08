/**
 * Migration V079 — Consolidate the authentication-debug config key
 *
 * Authentication debug logging was broken by a config key mismatch: the admin
 * UI and the shipped examples wrote a top-level `authDebug` block, while the
 * server (authDebugService, platformConfigSchema) only ever read `auth.debug`.
 * As a result the toggle silently did nothing.
 *
 * This migration moves any existing top-level `authDebug` into `auth.debug` so
 * installs that had configured it keep their setting, and drops the dead
 * `consoleLogging` flag (it was never wired to anything — Winston owns the
 * console transport).
 *
 * The admin's intent lived in the top-level `authDebug` key (that is what the
 * old UI persisted), so its values win over any stale `auth.debug` values.
 * Installs that never touched auth debug have no `authDebug` key and this
 * migration is a no-op for them.
 */
export const version = '079';
export const description = 'migrate_auth_debug_key';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  const legacy = platform.authDebug;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    // Nothing to migrate. Still strip a stray dead flag if it slipped into the
    // canonical location somehow.
    if (platform.auth?.debug && 'consoleLogging' in platform.auth.debug) {
      delete platform.auth.debug.consoleLogging;
      await ctx.writeJson('config/platform.json', platform);
      ctx.log('Removed dead consoleLogging flag from auth.debug');
      return;
    }
    ctx.log('No top-level authDebug key found; nothing to migrate');
    return;
  }

  // The dead flag never controlled anything — do not carry it forward.
  delete legacy.consoleLogging;

  platform.auth = platform.auth || {};
  const existing =
    platform.auth.debug &&
    typeof platform.auth.debug === 'object' &&
    !Array.isArray(platform.auth.debug)
      ? platform.auth.debug
      : {};

  // Merge providers shallowly with the same "legacy wins" precedence.
  const mergedProviders = { ...(existing.providers || {}), ...(legacy.providers || {}) };

  platform.auth.debug = {
    ...existing,
    ...legacy,
    ...(Object.keys(mergedProviders).length > 0 ? { providers: mergedProviders } : {})
  };
  delete platform.auth.debug.consoleLogging;

  delete platform.authDebug;

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Migrated top-level authDebug → auth.debug and dropped dead consoleLogging flag');
}
