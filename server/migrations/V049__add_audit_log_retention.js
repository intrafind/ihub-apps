export const version = '049';
export const description = 'add_audit_log_retention';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Default: keep audit log entries for 1 year and run daily cleanup.
  // Admins can change these via the platform config admin UI.
  ctx.setDefault(platform, 'auditLog.retentionDays', 365);
  ctx.setDefault(platform, 'auditLog.cleanupEnabled', true);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added auditLog.retentionDays (365) and auditLog.cleanupEnabled (true) defaults');
}
