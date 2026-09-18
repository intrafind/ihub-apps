/**
 * Migration V111 — CIMD client governance settings
 *
 * Two knobs for clients identified by a metadata document:
 *
 * - `oauth.cimd.blockedClientHosts` — evaluated *before* the allowlist and
 *   before any network call, so a whole vendor can be cut off without editing
 *   the allowlist an operator wants to keep. Empty by default: this migration
 *   blocks nobody.
 *
 * - `oauth.cimd.approvalMode` — `'approval'` (the default) means passing the
 *   host allowlist makes a client *eligible*, not allowed: an administrator
 *   still has to approve each `client_id` before anyone can connect through
 *   it. `'auto'` keeps the pre-governance behaviour, where the host allowlist
 *   is the whole decision.
 *
 * Shipping `'approval'` as the default is only safe because V112 grandfathers
 * every CIMD client that already has a connection. The two migrations belong
 * to the same release for exactly that reason.
 *
 * Installations that already define these keys are left alone.
 */

export const version = '111';
export const description = 'Add OAuth CIMD governance settings (blocked hosts, approval mode)';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/platform.json');

  if (!config.oauth || typeof config.oauth !== 'object') {
    ctx.warn('platform.json has no oauth section — skipping');
    return;
  }

  if (!config.oauth.cimd || typeof config.oauth.cimd !== 'object') {
    config.oauth.cimd = {};
  }

  const added = [];
  if (config.oauth.cimd.blockedClientHosts === undefined) {
    config.oauth.cimd.blockedClientHosts = [];
    added.push('blockedClientHosts');
  }
  if (config.oauth.cimd.approvalMode === undefined) {
    config.oauth.cimd.approvalMode = 'approval';
    added.push('approvalMode');
  }

  if (added.length === 0) {
    ctx.log('oauth.cimd governance settings already present — no changes needed');
    return;
  }

  await ctx.writeJson('config/platform.json', config);
  ctx.log(`Added oauth.cimd governance settings: ${added.join(', ')}`);
}
