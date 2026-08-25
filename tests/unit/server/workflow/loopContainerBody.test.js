import { describe, it, expect, jest } from '@jest/globals';

// PromptService pulls configLoader → pathUtils (import.meta), which the
// babel-jest CJS transform cannot compile — stub it before importing the
// executor. The executor under test never touches it.
jest.mock('../../../../server/services/PromptService.js', () => ({
  __esModule: true,
  default: {}
}));

// Mock the executor registry so loop bodies run against a lightweight echo
// executor instead of loading every real executor (LLM adapters etc.).
jest.mock('../../../../server/services/workflow/executors/index.js', () => ({
  __esModule: true,
  getExecutor: () => ({
    async execute(node, state) {
      if (node.config?.failAlways) {
        return { status: 'failed', output: null };
      }
      if (node.config?.delayMs) {
        await new Promise(resolve => setTimeout(resolve, node.config.delayMs));
      }
      return {
        status: 'completed',
        output: `${node.id}:${state.data._loopItem ?? state.data._loopIndex}`,
        stateUpdates: { [`ran_${node.id}`]: true }
      };
    }
  })
}));

import { LoopNodeExecutor } from '../../../../server/services/workflow/executors/LoopNodeExecutor.js';
import { DAGScheduler } from '../../../../server/services/workflow/DAGScheduler.js';
import { workflowConfigSchema } from '../../../../server/validators/workflowConfigSchema.js';

/** Builds a loop node with container children resolved via context.workflow */
function containerContext(children, edges = []) {
  return {
    workflow: {
      nodes: [
        { id: 'start', type: 'start', name: { en: 'Start' }, position: { x: 0, y: 0 } },
        {
          id: 'the-loop',
          type: 'loop',
          name: { en: 'Loop' },
          position: { x: 100, y: 0 }
        },
        ...children,
        { id: 'end', type: 'end', name: { en: 'End' }, position: { x: 200, y: 0 } }
      ],
      edges
    }
  };
}

function child(id, extra = {}) {
  return {
    id,
    type: 'transform',
    name: { en: id },
    position: { x: 10, y: 10 },
    parentId: 'the-loop',
    config: {},
    ...extra
  };
}

describe('LoopNodeExecutor.resolveContainerBody', () => {
  const executor = new LoopNodeExecutor();
  const loopNode = { id: 'the-loop', type: 'loop', config: {} };

  it('returns an empty body when the workflow has no children for this loop', () => {
    const context = containerContext([]);
    expect(executor.resolveContainerBody(loopNode, context)).toEqual([]);
  });

  it('orders children by sibling edges regardless of array order', () => {
    const context = containerContext(
      [child('step-b'), child('step-c'), child('step-a')],
      [
        { id: 'e1', source: 'step-a', target: 'step-b' },
        { id: 'e2', source: 'step-b', target: 'step-c' }
      ]
    );
    const body = executor.resolveContainerBody(loopNode, context);
    expect(body.map(n => n.id)).toEqual(['step-a', 'step-b', 'step-c']);
  });

  it('appends disconnected children in original order', () => {
    const context = containerContext(
      [child('step-a'), child('island'), child('step-b')],
      [{ id: 'e1', source: 'step-a', target: 'step-b' }]
    );
    const body = executor.resolveContainerBody(loopNode, context);
    expect(body.map(n => n.id)).toEqual(['step-a', 'island', 'step-b']);
  });

  it('ignores edges that reach outside the container', () => {
    const context = containerContext(
      [child('step-a')],
      [{ id: 'e1', source: 'start', target: 'step-a' }]
    );
    const body = executor.resolveContainerBody(loopNode, context);
    expect(body.map(n => n.id)).toEqual(['step-a']);
  });
});

describe('LoopNodeExecutor forEach over container children', () => {
  it('executes the container body once per item and collects results', async () => {
    const executor = new LoopNodeExecutor();
    const context = containerContext([child('analyze')]);
    const node = {
      id: 'the-loop',
      type: 'loop',
      config: { mode: 'forEach', array: 'items', outputVariable: 'collected' }
    };
    const state = { executionId: 'x1', data: { items: ['a', 'b', 'c'] } };

    const result = await executor.execute(node, state, context);

    expect(result.status).toBe('completed');
    expect(result.output.iterations).toBe(3);
    expect(result.stateUpdates.collected).toEqual(['analyze:a', 'analyze:b', 'analyze:c']);
  });

  it('prefers inline config.body over container children for backward compatibility', async () => {
    const executor = new LoopNodeExecutor();
    const context = containerContext([child('analyze')]);
    const node = {
      id: 'the-loop',
      type: 'loop',
      config: {
        mode: 'forEach',
        array: 'items',
        outputVariable: 'collected',
        body: [{ id: 'inline-step', type: 'transform', config: {} }]
      }
    };
    const state = { executionId: 'x2', data: { items: ['a'] } };

    const result = await executor.execute(node, state, context);
    expect(result.stateUpdates.collected).toEqual(['inline-step:a']);
  });

  it('runs iterations in parallel when concurrency > 1, keeping result order', async () => {
    const executor = new LoopNodeExecutor();
    // Delay makes out-of-order completion likely if order handling is wrong:
    // later items finish first because they wait less.
    const context = containerContext([child('work', { config: { delayMs: 20 } })]);
    context.workflow.nodes.find(n => n.id === 'work').config = { delayMs: 20 };
    const node = {
      id: 'the-loop',
      type: 'loop',
      config: { mode: 'forEach', array: 'items', outputVariable: 'collected', concurrency: 3 }
    };
    const state = { executionId: 'x3', data: { items: [1, 2, 3, 4, 5] } };

    const started = Date.now();
    const result = await executor.execute(node, state, context);
    const elapsed = Date.now() - started;

    expect(result.status).toBe('completed');
    expect(result.stateUpdates.collected).toEqual([
      'work:1',
      'work:2',
      'work:3',
      'work:4',
      'work:5'
    ]);
    // 5 items x 20ms at concurrency 3 should take ~2 waves, well under 5x20ms
    // sequential; generous bound to avoid CI flakiness.
    expect(elapsed).toBeLessThan(90);
  });

  it('does not propagate body state updates from parallel iterations', async () => {
    const executor = new LoopNodeExecutor();
    const context = containerContext([child('work')]);
    const node = {
      id: 'the-loop',
      type: 'loop',
      config: { mode: 'forEach', array: 'items', outputVariable: 'out', concurrency: 2 }
    };
    const state = { executionId: 'x4', data: { items: ['a', 'b'] } };

    const result = await executor.execute(node, state, context);
    expect(result.stateUpdates.out).toHaveLength(2);
    expect(result.stateUpdates.ran_work).toBeUndefined();
  });

  it('stops scheduling new parallel iterations after a failure', async () => {
    const executor = new LoopNodeExecutor();
    const context = containerContext([child('work', {})]);
    context.workflow.nodes.find(n => n.id === 'work').config = { failAlways: true };
    const node = {
      id: 'the-loop',
      type: 'loop',
      config: { mode: 'forEach', array: 'items', outputVariable: 'out', concurrency: 2 }
    };
    const state = { executionId: 'x5', data: { items: [1, 2, 3, 4, 5, 6, 7, 8] } };

    const result = await executor.execute(node, state, context);
    // With 2 workers, at most the first in-flight wave completes before the
    // failure flag stops scheduling — far fewer than all 8 items.
    expect(result.output.iterations).toBeLessThan(8);
  });
});

describe('DAGScheduler with container children', () => {
  const scheduler = new DAGScheduler();

  it('excludes loop-body nodes from start node detection', () => {
    const workflow = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'the-loop', type: 'loop' },
        { id: 'body-entry', type: 'transform', parentId: 'the-loop' },
        { id: 'end', type: 'end' }
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'the-loop' },
        { id: 'e2', source: 'the-loop', target: 'end' }
      ]
    };
    expect(scheduler.findStartNodes(workflow)).toEqual(['start']);
    expect(scheduler.findEndNodes(workflow)).toEqual(['end']);
  });
});

describe('workflowConfigSchema container validation', () => {
  const baseWorkflow = {
    id: 'container-test',
    name: { en: 'Container Test' },
    description: { en: 'Tests container children' },
    version: '1.0.0',
    nodes: [
      { id: 'start', type: 'start', name: { en: 'Start' }, position: { x: 0, y: 0 } },
      {
        id: 'the-loop',
        type: 'loop',
        name: { en: 'Loop' },
        position: { x: 100, y: 0 },
        size: { width: 500, height: 260 },
        config: { mode: 'forEach', array: 'items', outputVariable: 'results' }
      },
      {
        id: 'analyze',
        type: 'prompt',
        name: { en: 'Analyze' },
        position: { x: 40, y: 60 },
        parentId: 'the-loop',
        config: {}
      },
      { id: 'end', type: 'end', name: { en: 'End' }, position: { x: 200, y: 0 } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'the-loop' },
      { id: 'e2', source: 'the-loop', target: 'end' }
    ]
  };

  it('accepts a loop container with a body child that has no incoming edge', () => {
    const result = workflowConfigSchema.safeParse(baseWorkflow);
    expect(result.success).toBe(true);
  });

  it('rejects a parentId that points to a non-loop node', () => {
    const workflow = JSON.parse(JSON.stringify(baseWorkflow));
    workflow.nodes.find(n => n.id === 'analyze').parentId = 'start';
    const result = workflowConfigSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it('rejects a parentId that points to a missing node', () => {
    const workflow = JSON.parse(JSON.stringify(baseWorkflow));
    workflow.nodes.find(n => n.id === 'analyze').parentId = 'ghost';
    const result = workflowConfigSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it('rejects edges that cross the container boundary', () => {
    const workflow = JSON.parse(JSON.stringify(baseWorkflow));
    workflow.edges.push({ id: 'e3', source: 'start', target: 'analyze' });
    const result = workflowConfigSchema.safeParse(workflow);
    expect(result.success).toBe(false);
  });
});
