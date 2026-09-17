export const version = '085';
export const description = 'add_run_log_defaults';

// Adds the platform `runLog` section (ledger identity mode, retention) used by
// the unified runtime's RunLog service. The feature itself ships dark behind
// features.runLog (default false); these are the settings it reads once enabled.
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'runLog.enabled', true);
  ctx.setDefault(platform, 'runLog.identityMode', 'default');
  ctx.setDefault(platform, 'runLog.retentionDays', 90);
  ctx.setDefault(platform, 'runLog.cleanupEnabled', true);
  ctx.setDefault(platform, 'runLog.flushIntervalMs', 2000);
  ctx.setDefault(platform, 'runLog.spillThresholdBytes', 65536);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added runLog defaults (enabled=true, identityMode=default, retentionDays=90)');
}
