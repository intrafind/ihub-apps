// server/migrations/V152__replace_workflow_code_accumulator.js
export const version = '152';
export const description = 'replace_workflow_code_accumulator';

/** The code step the shipped corpus-analysis workflows used, and its follow-up. */
const ACCUMULATOR_ID = 'accumulate-corpus';
const UNWRAP_ID = 'unwrap-corpus-accumulator';
const SHIPPED_CODE =
  'const prev = data._corpusAll; const prevArr = Array.isArray(prev) ? prev : (prev && Array.isArray(prev.result) ? prev.result : []); [...prevArr, ...(data._corpus || [])];';

export async function precondition(ctx) {
  const files = await ctx.listFiles('workflows', '*.json');
  return files.length > 0;
}

/**
 * Workflow code nodes are no longer supported. The shipped corpus-analysis
 * workflows used one (`accumulate-corpus`) only to append each sub-question's
 * documents (`_corpus`) to `_corpusAll`, followed by a transform
 * (`unwrap-corpus-accumulator`) that copied the result into place. Both
 * become one transform with an `append` operation; the follow-up step is
 * removed and its outgoing edges start at the accumulator instead. When that
 * step was changed or removed by an admin, the accumulator also writes the
 * value it used to read (`_corpusAllRaw.result`).
 *
 * Only the code the workflows shipped with is replaced. An accumulator whose
 * code an admin changed, and any other code node, is left as it is and
 * listed: those workflows fail when run until the node is replaced.
 */
export async function up(ctx) {
  const files = await ctx.listFiles('workflows', '*.json');
  const withCodeNodes = [];

  for (const file of files) {
    const path = `workflows/${file}`;
    const workflow = await ctx.readJson(path);
    if (!workflow || !Array.isArray(workflow.nodes)) continue;

    if (replaceAccumulator(workflow)) {
      await ctx.writeJson(path, workflow);
      ctx.log(`Replaced the code node "${ACCUMULATOR_ID}" in workflows/${file}`);
    }
    if (hasCodeNode(workflow.nodes)) withCodeNodes.push(file);
  }

  if (withCodeNodes.length > 0) {
    ctx.warn(
      `Workflows with code nodes, which are no longer supported, fail when run until the node is replaced: ${withCodeNodes.join(', ')}`
    );
  }
}

/**
 * Replace the shipped accumulator code node in `workflow`, if present.
 *
 * @param {object} workflow
 * @returns {boolean} Whether the workflow changed
 */
export function replaceAccumulator(workflow) {
  const nodes = allNodes(workflow.nodes);
  const accumulator = nodes.find(
    node =>
      node.id === ACCUMULATOR_ID &&
      node.type === 'code' &&
      node.config?.outputVariable === '_corpusAllRaw' &&
      typeof node.config?.code === 'string' &&
      node.config.code.trim() === SHIPPED_CODE
  );
  if (!accumulator) return false;

  const unwrap = nodes.find(node => node.id === UNWRAP_ID);
  const unwrapIsShipped =
    unwrap?.type === 'transform' &&
    JSON.stringify(unwrap.config?.operations) ===
      JSON.stringify([{ copy: '_corpusAllRaw.result', to: '_corpusAll' }]);
  // Another edge into the unwrap step would point at a missing node once it is removed.
  const unwrapHasOtherInputs = (workflow.edges || []).some(
    edge => edge.target === UNWRAP_ID && edge.source !== ACCUMULATOR_ID
  );
  const removeUnwrap = unwrapIsShipped && !unwrapHasOtherInputs;

  const operations = [{ append: '_corpus', to: '_corpusAll' }];
  if (!removeUnwrap) {
    operations.push({ copy: '_corpusAll', to: '_corpusAllRaw.result' });
  }
  accumulator.type = 'transform';
  accumulator.config = {
    ...(accumulator.config?.chatVisible !== undefined && {
      chatVisible: accumulator.config.chatVisible
    }),
    operations
  };

  if (removeUnwrap) {
    removeNode(workflow, UNWRAP_ID);
    workflow.edges = (workflow.edges || [])
      .filter(edge => !(edge.source === ACCUMULATOR_ID && edge.target === UNWRAP_ID))
      .map(edge => (edge.source === UNWRAP_ID ? { ...edge, source: ACCUMULATOR_ID } : edge));
  }
  return true;
}

/** Every node, including loop bodies kept inline under `config.body`. */
function allNodes(nodes, out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue;
    out.push(node);
    if (Array.isArray(node.config?.body)) allNodes(node.config.body, out);
  }
  return out;
}

function hasCodeNode(nodes) {
  return allNodes(nodes).some(node => node.type === 'code');
}

/** Remove the node `id` from the top level or from a loop body. */
function removeNode(workflow, id) {
  const prune = nodes => {
    if (!Array.isArray(nodes)) return nodes;
    return nodes
      .filter(node => node?.id !== id)
      .map(node =>
        Array.isArray(node?.config?.body)
          ? { ...node, config: { ...node.config, body: prune(node.config.body) } }
          : node
      );
  };
  workflow.nodes = prune(workflow.nodes);
}
