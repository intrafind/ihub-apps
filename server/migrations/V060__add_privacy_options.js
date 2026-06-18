/**
 * Migration V060 — Privacy controls and rollup/feedback retention
 *
 * Adds three privacy/retention settings to platform.json:
 *
 *   - `audit.anonymizeIp`   (boolean | 'off' | 'mask' | 'drop', default false)
 *       Controls how the client IP is stored on audit log entries.
 *
 *   - `logging.anonymizeIp` (boolean | 'off' | 'mask' | 'drop', default false)
 *       Controls how the client IP is merged into structured log lines from
 *       the per-request AsyncLocalStorage context.
 *
 *   - `usageTracking.feedbackRetentionDays` (number, default -1)
 *       Drop feedback.jsonl entries older than this many days. `-1` keeps
 *       feedback forever (the existing behaviour).
 *
 *   Also pins the previously-undefaulted rollup retention keys
 *   (`eventRetentionDays`, `dailyRetentionDays`, `monthlyRetentionDays`) so
 *   admin tooling can read them back from the config without ambiguity.
 *
 * Existing admin-configured values are preserved; only missing keys get the
 * defaults. Privacy defaults stay `false` so the upgrade itself is a no-op
 * for current deployments — admins opt into anonymization explicitly.
 */
export const version = '060';
export const description = 'add_privacy_options';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'audit.anonymizeIp', false);
  ctx.setDefault(platform, 'logging.anonymizeIp', false);

  // Pin the rollup retention defaults that V022 introduced so the
  // usageTracking block is fully populated when admins inspect it.
  ctx.setDefault(platform, 'usageTracking.eventRetentionDays', 90);
  ctx.setDefault(platform, 'usageTracking.dailyRetentionDays', 365);
  ctx.setDefault(platform, 'usageTracking.monthlyRetentionDays', -1);
  ctx.setDefault(platform, 'usageTracking.feedbackRetentionDays', -1);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added IP anonymization toggles and feedback retention default');
}
