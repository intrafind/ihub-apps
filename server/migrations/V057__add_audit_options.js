/**
 * Migration V057 — Add audit logging options to platform.json
 *
 * Introduces the `audit` configuration block that controls the expanded audit
 * logging system (auth events, OAuth clients, users, and the global HTTP audit
 * safety net):
 *
 *   - audit.includeEmail   When false (default), email-shaped actor identifiers
 *                          are masked in audit entries for privacy.
 *   - audit.verbosity      'metadata' (default), 'request', or 'full' — controls
 *                          how much request detail the global middleware records.
 *   - audit.winstonMirror  When true, audit entries are also emitted to the
 *                          structured logger (component: 'audit') for SIEM routing.
 *
 * Existing admin-configured values are preserved; only missing keys get defaults.
 */
export const version = '057';
export const description = 'add_audit_options';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'audit.includeEmail', false);
  ctx.setDefault(platform, 'audit.verbosity', 'metadata');
  ctx.setDefault(platform, 'audit.winstonMirror', false);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added audit options (includeEmail, verbosity, winstonMirror) to platform.json');
}
