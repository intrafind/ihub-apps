/**
 * Migration V099 — Do not sweep workflow history an admin never opted in to
 *
 * V098 seeded `workflowState.cleanupEnabled: true`, which is right for a fresh
 * installation and wrong for an upgrade. `cleanupEnabled` and `retentionDays`
 * are keys that never existed before, so `setDefault` preserved no operator
 * choice — there was none to preserve. An installation that had been running
 * workflows for a year therefore got a sweep it never asked for, and its first
 * tick removes every terminal execution older than thirty days: the full
 * workflow definition and every node result, gone within a day of the upgrade.
 *
 * V098 cannot be edited — migrations are frozen once applied — so this one
 * corrects it forward, and only where it matters. An installation with
 * existing workflow state has that history opted *out*; a fresh one, or one
 * that has never run a workflow, keeps the default on. Either way the setting
 * is now visible in Admin → Platform Configuration, which is where the
 * decision belongs.
 *
 * The sweep is separately gated on the `workflows` feature flag, so an
 * installation that never turned workflows on is unaffected regardless.
 */

export const version = '099';
export const description = 'workflow_retention_opt_in_for_upgrades';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const hasExistingState = await ctx.fileExists('data/workflow-state');
  if (!hasExistingState) {
    ctx.log('No pre-existing workflow state; leaving workflowState.cleanupEnabled as seeded');
    return;
  }

  const platform = await ctx.readJson('config/platform.json');
  if (!platform) {
    ctx.warn('platform.json could not be read; workflowState.cleanupEnabled left as seeded');
    return;
  }

  // Only the value V098 itself seeded is turned off. An admin who has already
  // been through Admin → Platform Configuration and chosen `true` deliberately
  // keeps that choice — this migration is undoing a default, not a decision,
  // and it cannot tell the two apart except by having run in the same upgrade.
  if (platform.workflowState?.cleanupEnabled !== true) {
    ctx.log('workflowState.cleanupEnabled is not the seeded default; left untouched');
    return;
  }

  platform.workflowState.cleanupEnabled = false;
  await ctx.writeJson('config/platform.json', platform);
  ctx.log(
    'Existing workflow state found: workflowState.cleanupEnabled set to false so the ' +
      'retention sweep does not remove history predating this upgrade. Turn it on in ' +
      'Admin → Platform Configuration to enable the 30-day sweep.'
  );
}
