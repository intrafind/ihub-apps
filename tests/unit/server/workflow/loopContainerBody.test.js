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
      if (node.config?.pauses) {
        return { status: 'paused', output: null };
      }
      if (node.config?.delayMs) {
        const probe = (globalThis.__loopProbe ??= { inflight: 0, max: 0 });
        probe.inflight += 1;
        probe.max = Math.max(probe.max, probe.inflight);
        await new Promise(resolve => setTimeout(resolve, node.config.delayMs));
        probe.inflight -= 1;
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

    globalThis.__loopProbe = { inflight: 0, max: 0 };
    const result = await executor.execute(node, state, context);

    expect(result.status).toBe('completed');
    expect(result.stateUpdates.collected).toEqual([
      'work:1',
      'work:2',
      'work:3',
      'work:4',
      'work:5'
    ]);
    // Measured rather than timed: iterations really do overlap, and never
    // more than the configured concurrency at once.
    expect(globalThis.__loopProbe.max).toBeGreaterThan(1);
    expect(globalThis.__loopProbe.max).toBeLessThanOrEqual(3);
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

describe('conditional paths inside a loop body', () => {
  /** Body: entry -> (flagged ? extra : join) -> join */
  function branchingContext() {
    const ctx = containerContext(
      [child('entry'), child('extra'), child('join')],
      [
        {
          id: 'b1',
          source: 'entry',
          target: 'extra',
          condition: { type: 'equals', field: 'data.flag', value: 'yes' }
        },
        {
          id: 'b2',
          source: 'entry',
          target: 'join',
          condition: { type: 'equals', field: 'data.flag', value: 'no' }
        },
        { id: 'b3', source: 'extra', target: 'join' }
      ]
    );
    return ctx;
  }

  const node = {
    id: 'the-loop',
    type: 'loop',
    config: { mode: 'forEach', array: 'items', outputVariable: 'out' }
  };

  it('takes the matching branch and skips the other step', async () => {
    const executor = new LoopNodeExecutor();
    const state = { executionId: 'c1', data: { items: ['a'], flag: 'no' } };
    const result = await executor.execute(node, state, branchingContext());
    // The last body node reached is `join`; `extra` was skipped entirely
    expect(result.stateUpdates.out).toEqual(['join:a']);
    expect(result.stateUpdates.ran_extra).toBeUndefined();
    expect(result.stateUpdates.ran_join).toBe(true);
  });

  it('runs the optional step when its condition holds', async () => {
    const executor = new LoopNodeExecutor();
    const state = { executionId: 'c2', data: { items: ['a'], flag: 'yes' } };
    const result = await executor.execute(node, state, branchingContext());
    expect(result.stateUpdates.ran_extra).toBe(true);
    expect(result.stateUpdates.ran_join).toBe(true);
  });

  it('still runs every node when the body has no edges', async () => {
    const executor = new LoopNodeExecutor();
    const ctx = containerContext([child('one'), child('two')]);
    const state = { executionId: 'c3', data: { items: ['a'] } };
    const result = await executor.execute(node, state, ctx);
    expect(result.stateUpdates.ran_one).toBe(true);
    expect(result.stateUpdates.ran_two).toBe(true);
  });

  it('does not run past a failing body node', async () => {
    const executor = new LoopNodeExecutor();
    const ctx = containerContext(
      [child('boom'), child('after')],
      [{ id: 'e', source: 'boom', target: 'after' }]
    );
    ctx.workflow.nodes.find(n => n.id === 'boom').config = { failAlways: true };
    const state = { executionId: 'c4', data: { items: ['a'] } };
    const result = await executor.execute(node, state, ctx);
    expect(result.stateUpdates.ran_after).toBeUndefined();
  });

  it('stops an iteration whose body edges form a cycle', async () => {
    const executor = new LoopNodeExecutor();
    const ctx = containerContext(
      [child('ping'), child('pong')],
      [
        { id: 'e1', source: 'ping', target: 'pong' },
        { id: 'e2', source: 'pong', target: 'ping' }
      ]
    );
    const state = { executionId: 'c5', data: { items: ['a'] } };
    const result = await executor.execute(node, state, ctx);
    // The step cap ends the iteration instead of spinning forever
    expect(result.status).toBe('completed');
    expect(result.output.iterations).toBe(1);
  });
});

describe('nested loop containers', () => {
  it('restores the outer loop item after an inner loop finishes', async () => {
    const executor = new LoopNodeExecutor();
    // outer(forEach groups) > [inner(forEach items), after]
    const context = {
      workflow: {
        nodes: [
          { id: 'outer', type: 'loop' },
          {
            id: 'inner',
            type: 'loop',
            parentId: 'outer',
            config: { mode: 'forEach', array: 'items' }
          },
          { id: 'after', type: 'transform', parentId: 'outer', config: {} },
          { id: 'leaf', type: 'transform', parentId: 'inner', config: {} }
        ],
        edges: [{ id: 'e', source: 'inner', target: 'after' }]
      }
    };
    const node = {
      id: 'outer',
      type: 'loop',
      config: { mode: 'forEach', array: 'groups', outputVariable: 'out' }
    };
    const state = { executionId: 'n1', data: { groups: ['g1', 'g2'], items: ['i1'] } };

    const result = await executor.execute(node, state, context);

    // `after` runs once per OUTER item and still sees that outer item —
    // the inner loop no longer clobbers it on cleanup.
    expect(result.stateUpdates.out).toEqual(['after:g1', 'after:g2']);
  });

  it('leaves no loop variables behind once a top-level loop completes', async () => {
    const executor = new LoopNodeExecutor();
    const context = containerContext([child('work')]);
    const node = {
      id: 'the-loop',
      type: 'loop',
      config: { mode: 'forEach', array: 'items', outputVariable: 'out' }
    };
    const state = { executionId: 'n2', data: { items: ['a'] } };

    const result = await executor.execute(node, state, context);
    for (const key of ['_loopItem', '_loopIndex', '_loopHuman', '_loopTotal']) {
      expect(result.stateUpdates[key]).toBeUndefined();
    }
  });
});

describe('human steps inside a loop body', () => {
  it('fails the iteration instead of silently ignoring a pause', async () => {
    const executor = new LoopNodeExecutor();
    const context = containerContext([child('ask-a-person'), child('after')]);
    context.workflow.nodes.find(n => n.id === 'ask-a-person').config = { pauses: true };
    const node = {
      id: 'the-loop',
      type: 'loop',
      config: { mode: 'forEach', array: 'items', outputVariable: 'out' }
    };
    const state = { executionId: 'p1', data: { items: ['a', 'b'] } };

    const result = await executor.execute(node, state, context);
    // The step after the pausing node must not have run, and the loop stops.
    expect(result.stateUpdates.ran_after).toBeUndefined();
    expect(result.output.iterations).toBe(1);
  });
});
