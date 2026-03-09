/**
 * Migration V013 — Enhanced Usage Tracking
 *
 * Adds usageTrackingMode feature flag and usageTracking retention config
 * to platform.json. Also adds tokenSources to existing usage.json.
 */

export const version = '013';
export const description = 'Enhanced usage tracking configuration';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  // Add tracking mode and retention config to platform.json
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'features.usageTrackingMode', 'pseudonymous');
  ctx.setDefault(platform, 'usageTracking.eventRetentionDays', 90);
  ctx.setDefault(platform, 'usageTracking.dailyRetentionDays', 365);
  ctx.setDefault(platform, 'usageTracking.monthlyRetentionDays', -1);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added usageTrackingMode and usageTracking retention config');

  // Add tokenSources to existing usage.json if it exists
  if (await ctx.fileExists('data/usage.json')) {
    try {
      const usage = await ctx.readJson('data/usage.json');
      ctx.setDefault(usage, 'tokenSources', { provider: 0, estimate: 0 });
      await ctx.writeJson('data/usage.json', usage);
      ctx.log('Added tokenSources to usage.json');
    } catch (e) {
      ctx.warn('Could not update usage.json: ' + e.message);
    }
  }
}
