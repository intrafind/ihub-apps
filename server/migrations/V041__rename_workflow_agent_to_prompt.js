export const version = '041';
export const description = 'rename_workflow_agent_to_prompt';

export async function precondition(ctx) {
  const files = await ctx.listFiles('workflows', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('workflows', '*.json');
  let migratedCount = 0;

  for (const file of files) {
    const path = `workflows/${file}`;
    const workflow = await ctx.readJson(path);
    if (!workflow || !Array.isArray(workflow.nodes)) continue;

    let touched = 0;
    for (const node of workflow.nodes) {
      if (node && node.type === 'agent') {
        node.type = 'prompt';
        touched++;
      }
    }

    if (touched > 0) {
      await ctx.writeJson(path, workflow);
      ctx.log(`Renamed ${touched} agent node(s) to prompt in workflows/${file}`);
      migratedCount++;
    }
  }

  if (migratedCount === 0) {
    ctx.log('No workflows contained agent nodes to rename');
  } else {
    ctx.log(`Renamed agent node type in ${migratedCount} workflow(s)`);
  }
}
