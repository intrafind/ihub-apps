export const version = '039';
export const description = 'move_workflow_tools_to_workflows';

export async function precondition(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  let migratedCount = 0;

  for (const file of files) {
    const path = `apps/${file}`;
    const app = await ctx.readJson(path);
    if (!app || !Array.isArray(app.tools)) continue;

    const workflowEntries = app.tools.filter(
      t => typeof t === 'string' && t.startsWith('workflow:')
    );
    if (workflowEntries.length === 0) continue;

    const extractedIds = workflowEntries
      .map(t => t.slice('workflow:'.length))
      .filter(id => id.length > 0);

    const existingWorkflows = Array.isArray(app.workflows) ? app.workflows : [];
    const mergedWorkflows = Array.from(new Set([...existingWorkflows, ...extractedIds]));
    const remainingTools = app.tools.filter(
      t => typeof t !== 'string' || !t.startsWith('workflow:')
    );

    app.workflows = mergedWorkflows;
    app.tools = remainingTools;

    await ctx.writeJson(path, app);
    ctx.log(
      `Moved ${extractedIds.length} workflow(s) from tools to workflows in apps/${file}: ${extractedIds.join(', ')}`
    );
    migratedCount++;
  }

  if (migratedCount === 0) {
    ctx.log('No apps had workflow:* tool entries to migrate');
  } else {
    ctx.log(`Migrated workflow references in ${migratedCount} app(s)`);
  }
}
