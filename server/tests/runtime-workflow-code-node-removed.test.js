/**
 * Workflows have no code node type any more: there is no executor for it,
 * the workflow schema rejects it, and no shipped workflow uses one. The
 * shipped corpus-analysis workflows collect documents with the transform
 * node's `append` operation instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getExecutor } from '../services/workflow/executors/index.js';
import { TransformNodeExecutor } from '../services/workflow/executors/TransformNodeExecutor.js';
import { workflowConfigSchema } from '../validators/workflowConfigSchema.js';

const defaultsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'defaults',
  'workflows'
);
const shippedWorkflows = readdirSync(defaultsDir)
  .filter(file => file.endsWith('.json'))
  .map(file => ({
    file,
    workflow: JSON.parse(readFileSync(path.join(defaultsDir, file), 'utf8'))
  }));

const allNodes = nodes => (nodes || []).flatMap(node => [node, ...allNodes(node?.config?.body)]);

describe('workflow code node', () => {
  it('has no executor', () => {
    assert.throws(() => getExecutor('code'), /No executor found for node type: 'code'/);
  });

  it('is rejected by the workflow schema', () => {
    const workflow = structuredClone(
      shippedWorkflows.find(({ file }) => file === 'corpus-analysis-decomposed.json').workflow
    );
    workflow.nodes.find(node => node.id === 'accumulate-corpus').type = 'code';
    const result = workflowConfigSchema.safeParse(workflow);
    assert.equal(result.success, false);
    assert.ok(result.error.issues.some(issue => issue.path.includes('type')));
  });

  it('is not used by any shipped workflow', () => {
    for (const { file, workflow } of shippedWorkflows) {
      assert.deepEqual(
        allNodes(workflow.nodes).filter(node => node.type === 'code'),
        [],
        `${file} has a code node`
      );
    }
  });

  it('leaves the corpus-analysis workflows valid, collecting documents with append', () => {
    for (const file of ['corpus-analysis-decomposed.json', 'corpus-analysis-decomposed-v2.json']) {
      const { workflow } = shippedWorkflows.find(entry => entry.file === file);
      const result = workflowConfigSchema.safeParse(workflow);
      assert.ok(result.success, `${file}: ${JSON.stringify(result.error?.issues?.slice(0, 3))}`);

      const ids = new Set(allNodes(workflow.nodes).map(node => node.id));
      for (const edge of workflow.edges) {
        assert.ok(
          ids.has(edge.source) && ids.has(edge.target),
          `${file}: dangling edge ${edge.id}`
        );
      }
      const accumulator = allNodes(workflow.nodes).find(node => node.id === 'accumulate-corpus');
      assert.equal(accumulator.type, 'transform');
      assert.deepEqual(accumulator.config.operations, [{ append: '_corpus', to: '_corpusAll' }]);
    }
  });
});

describe('transform append operation', () => {
  const run = async (data, operation) => {
    const executor = new TransformNodeExecutor();
    const result = await executor.execute(
      { id: 'append', type: 'transform', config: { operations: [operation] } },
      { data },
      {}
    );
    assert.equal(result.status, 'completed');
    return result.stateUpdates;
  };

  it('appends every item of the source array to the target array', async () => {
    const updates = await run(
      { _corpus: [{ id: 'b' }, { id: 'c' }], _corpusAll: [{ id: 'a' }] },
      { append: '_corpus', to: '_corpusAll' }
    );
    assert.deepEqual(updates._corpusAll, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('starts an empty target and appends nothing for a missing or null source', async () => {
    assert.deepEqual(
      (await run({ _corpus: ['x'] }, { append: '_corpus', to: '_corpusAll' }))._corpusAll,
      ['x']
    );
    assert.deepEqual(
      (await run({ _corpus: null, _corpusAll: ['a'] }, { append: '_corpus', to: '_corpusAll' }))
        ._corpusAll,
      ['a']
    );
  });

  it('copies the appended items rather than sharing them with the source', async () => {
    const source = [{ id: 'b' }];
    const updates = await run({ _corpus: source }, { append: '_corpus', to: '_corpusAll' });
    updates._corpusAll[0].id = 'changed';
    assert.equal(source[0].id, 'b');
  });
});
