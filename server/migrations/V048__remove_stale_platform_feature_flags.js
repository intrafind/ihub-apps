// server/migrations/V048__remove_stale_platform_feature_flags.js
//
// Feature flags live in `contents/config/features.json` (the canonical
// source consumed by configCache.getFeatures + featureRegistry.isFeatureEnabled).
// `platform.json` had leftover `features.appAsTool` and `features.agentFactory`
// entries that did NOT track the canonical state — readers that consulted
// `platform.features.appAsTool` saw stale data, which in turn caused apps to
// silently NOT be registered as tools on agent runs even when the real
// feature was on. The stale code paths have been fixed to read from
// features.json; this migration removes the leftover keys from disk so
// existing installations are consistent too.
//
// `features.usageTrackingMode` (non-boolean configuration, not a feature
// toggle) stays in platform.json — it is read from there by usageTracker.js.

export const version = '048';
export const description = 'remove_stale_platform_feature_flags';

const STALE_KEYS = ['appAsTool', 'agentFactory'];

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  if (!platform || typeof platform !== 'object') return;
  if (!platform.features || typeof platform.features !== 'object') return;

  let removed = 0;
  for (const key of STALE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(platform.features, key)) {
      delete platform.features[key];
      removed += 1;
    }
  }

  if (removed === 0) {
    ctx.log('No stale platform feature flags to remove');
    return;
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Removed ${removed} stale feature flag(s) from platform.json: ${STALE_KEYS.join(', ')}`);
}
