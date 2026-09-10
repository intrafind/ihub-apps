/**
 * Migration V096 — Seed the platform `workflowState` section
 *
 * Workflow execution state was the one runtime store nothing ever swept. A
 * completed run left its `latest.json` behind — the full workflow definition
 * plus every node result, tens to hundreds of kilobytes — along with its
 * registry entry, until somebody pressed delete in the UI. Sub-workflow
 * states (`wf-child-*`) had no delete route at all, so they were pure
 * accumulation. A daily retention sweep now removes terminal executions:
 *
 * - `workflowState.retentionDays`   — age after which a *terminal* execution
 *                                     (completed, failed or cancelled) is
 *                                     removed together with its state and its
 *                                     run summary; <= 0 keeps them forever.
 * - `workflowState.cleanupEnabled`  — master switch for that sweep.
 *
 * A paused execution is waiting for a person to answer a checkpoint and is
 * never swept, however old.
 *
 * Both values are the built-in defaults, so the section is only made visible
 * and editable in Admin → Platform Configuration rather than appearing out of
 * nowhere the first time an admin goes looking for it. `setDefault` never
 * overwrites a choice already in the file, so an installation that has
 * already tuned the window — including one that set `retentionDays` to 0 to
 * opt out of deletion entirely — keeps it.
 */

export const version = '096';
export const description = 'add_workflow_state_retention';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'workflowState.retentionDays', 30);
  ctx.setDefault(platform, 'workflowState.cleanupEnabled', true);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added workflowState defaults (retentionDays=30, cleanupEnabled=true)');
}
