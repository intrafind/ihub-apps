export const version = '043';
export const description = 'rename_agent_in_persisted_state';

/**
 * V040 renamed the `agent` node type to `prompt` in workflow definitions on
 * disk. But persisted execution snapshots (contents/data/workflow-state/<id>/
 * latest.json) bake the workflow definition into `state.data._workflowDefinition`
 * at the time the workflow started. Older executions therefore still reference
 * `type: "agent"` and the engine throws "No executor registered for node type:
 * agent" when an admin clicks Resume on those.
 *
 * Walk every state snapshot and rewrite any `nodes[].type === 'agent'` to
 * `prompt`. We only flip the field when the enclosing path traversed a `nodes`
 * array, so we never touch unrelated user data.
 */

function rewriteAgentNodes(value, insideNodesArray = false) {
  if (Array.isArray(value)) {
    let touched = 0;
    for (const item of value) {
      touched += rewriteAgentNodes(item, insideNodesArray);
    }
    return touched;
  }
  if (value && typeof value === 'object') {
    let touched = 0;
    if (insideNodesArray && value.type === 'agent') {
      value.type = 'prompt';
      touched++;
    }
    for (const [k, v] of Object.entries(value)) {
      touched += rewriteAgentNodes(v, k === 'nodes');
    }
    return touched;
  }
  return 0;
}

export async function precondition(ctx) {
  if (!(await ctx.fileExists('data/workflow-state'))) return false;
  const entries = await ctx.listFiles('data/workflow-state');
  return entries.some(name => name.startsWith('wf-exec-'));
}

export async function up(ctx) {
  const entries = await ctx.listFiles('data/workflow-state');
  let migratedFiles = 0;
  let totalRewrites = 0;

  for (const name of entries) {
    if (!name.startsWith('wf-exec-')) continue;
    const path = `data/workflow-state/${name}/latest.json`;
    if (!(await ctx.fileExists(path))) continue;

    let state;
    try {
      state = await ctx.readJson(path);
    } catch (error) {
      ctx.warn(`Skipping unreadable state file ${path}: ${error.message}`);
      continue;
    }

    const touched = rewriteAgentNodes(state);
    if (touched > 0) {
      await ctx.writeJson(path, state);
      migratedFiles++;
      totalRewrites += touched;
      ctx.log(`Rewrote ${touched} agent→prompt reference(s) in ${path}`);
    }
  }

  if (migratedFiles === 0) {
    ctx.log('No persisted state files contained agent nodes');
  } else {
    ctx.log(
      `Migrated ${totalRewrites} agent→prompt references across ${migratedFiles} state file(s)`
    );
  }
}
