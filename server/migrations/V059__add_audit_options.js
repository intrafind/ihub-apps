/**
 * Migration V059 — Consolidate audit config into a single `audit` block
 *
 * The expanded audit logging system uses one platform.json block, `audit`,
 * for both retention and behavior/privacy:
 *
 *   - audit.retentionDays  Daily JSONL files older than this are cleaned up.
 *   - audit.cleanupEnabled Toggle for the retention cleanup job.
 *   - audit.includeEmail   When false (default), email-shaped actor identifiers
 *                          are masked in audit entries for privacy.
 *   - audit.verbosity      'metadata' (default), 'request', or 'full' — controls
 *                          how much request detail the global middleware records.
 *   - audit.winstonMirror  When true, audit entries are also emitted to the
 *                          structured logger (component: 'audit') for SIEM routing.
 *
 * Retention previously lived in a separate top-level `auditLog` block (added by
 * V049). This migration moves any admin-configured values from `auditLog` into
 * `audit`, then removes the legacy block. Existing values are preserved; only
 * missing keys get defaults.
 */
export const version = '059';
export const description = 'add_audit_options';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Carry forward retention settings from the legacy `auditLog` block (V049).
  const legacy = platform.auditLog || {};
  ctx.setDefault(
    platform,
    'audit.retentionDays',
    Number.isFinite(legacy.retentionDays) ? legacy.retentionDays : 365
  );
  ctx.setDefault(platform, 'audit.cleanupEnabled', legacy.cleanupEnabled !== false);

  // Behavior / privacy defaults.
  ctx.setDefault(platform, 'audit.includeEmail', false);
  ctx.setDefault(platform, 'audit.verbosity', 'metadata');
  ctx.setDefault(platform, 'audit.winstonMirror', false);

  // Remove the now-consolidated legacy block.
  ctx.removeKey(platform, 'auditLog');

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Consolidated audit config into the `audit` block and removed legacy `auditLog`');
}
