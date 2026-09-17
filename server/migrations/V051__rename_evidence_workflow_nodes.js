export const version = '051';
export const description = 'rename_evidence_workflow_nodes';

const TYPE_RENAMES = {
  'evidence-collect': 'structured-record',
  'report-compose': 'template-render'
};

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

    const touched = renameNodeTypes(workflow.nodes);
    if (touched > 0) {
      await ctx.writeJson(path, workflow);
      ctx.log(`Renamed ${touched} node(s) in workflows/${file}`);
      migratedCount++;
    }
  }

  if (migratedCount === 0) {
    ctx.log('No workflows contained evidence-collect/report-compose nodes');
  } else {
    ctx.log(`Migrated node types in ${migratedCount} workflow(s)`);
  }
}

// Walk nodes recursively so loop bodies (and any other nested-node shape)
// are also migrated. V041 only handled top-level nodes; corpus-analysis-*
// workflows have `structured-record` nodes nested inside `loop.body`.
function renameNodeTypes(nodes) {
  let touched = 0;
  if (!Array.isArray(nodes)) return touched;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (typeof node.type === 'string' && TYPE_RENAMES[node.type]) {
      node.type = TYPE_RENAMES[node.type];
      touched++;
    }
    // Loop nodes carry their body nodes inline under `config.body`.
    if (node.config && Array.isArray(node.config.body)) {
      touched += renameNodeTypes(node.config.body);
    }
  }
  return touched;
}
