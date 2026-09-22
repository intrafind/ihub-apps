import { describe, it, expect } from '@jest/globals';
import {
  workflowToFlow,
  flowToWorkflow,
  collectUpstreamVariables,
  createNewNode,
  createStarterWorkflow,
  parentsFirst
} from '../../../client/src/features/workflows/editor/workflowEditorUtils.js';
import { workflowConfigSchema } from '../../../server/validators/workflowConfigSchema.js';

const containerWorkflow = {
  id: 'wf-1',
  name: { en: 'Container WF' },
  description: { en: 'x' },
  version: '1.0.0',
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start', de: 'Startknoten' },
      position: { x: 0, y: 0 },
      config: { inputVariables: [{ name: 'topic', type: 'string', required: true }] }
    },
    {
      id: 'search',
      type: 'prompt',
      name: { en: 'Search' },
      description: { en: 'finds things' },
      position: { x: 250, y: 0 },
      config: { outputVariable: 'searchResults' },
      execution: { timeout: 60000, retries: 2 }
    },
    {
      id: 'the-loop',
      type: 'loop',
      name: { en: 'Analyze each' },
      position: { x: 500, y: 0 },
      size: { width: 520, height: 300 },
      config: { mode: 'forEach', array: 'searchResults', outputVariable: 'analyses' }
    },
    {
      id: 'analyze',
      type: 'prompt',
      name: { en: 'Analyze' },
      position: { x: 40, y: 80 },
      parentId: 'the-loop',
      config: { outputVariable: 'analysis' }
    },
    { id: 'end', type: 'end', name: { en: 'End' }, position: { x: 1100, y: 0 }, config: {} }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'search' },
    { id: 'e2', source: 'search', target: 'the-loop' },
    {
      id: 'e3',
      source: 'the-loop',
      target: 'end',
      sourceHandle: 'true',
      condition: { type: 'equals', field: 'result.branch', value: 'true' },
      label: { en: 'done' }
    }
  ]
};

describe('workflowToFlow', () => {
  it('renders loop nodes as sized containers and children with parentId', () => {
    const { nodes } = workflowToFlow(containerWorkflow);
    const loop = nodes.find(n => n.id === 'the-loop');
    expect(loop.type).toBe('loopContainer');
    expect(loop.width).toBe(520);
    expect(loop.height).toBe(300);

    const child = nodes.find(n => n.id === 'analyze');
    expect(child.parentId).toBe('the-loop');
    // Parents must come before children in the array (React Flow requirement)
    expect(nodes.findIndex(n => n.id === 'the-loop')).toBeLessThan(
      nodes.findIndex(n => n.id === 'analyze')
    );
  });

  it('keeps edge handles, conditions, and labels', () => {
    const { edges } = workflowToFlow(containerWorkflow);
    const e3 = edges.find(e => e.id === 'e3');
    expect(e3.sourceHandle).toBe('true');
    expect(e3.data.condition).toEqual({ type: 'equals', field: 'result.branch', value: 'true' });
    expect(e3.data.label).toEqual({ en: 'done' });
  });
});

describe('flowToWorkflow round-trip', () => {
  it('is lossless for names, descriptions, execution, parentId, size, and edges', () => {
    const { nodes, edges } = workflowToFlow(containerWorkflow);
    const roundTripped = flowToWorkflow(nodes, edges, containerWorkflow);

    const start = roundTripped.nodes.find(n => n.id === 'start');
    expect(start.name).toEqual({ en: 'Start', de: 'Startknoten' });

    const search = roundTripped.nodes.find(n => n.id === 'search');
    expect(search.description).toEqual({ en: 'finds things' });
    expect(search.execution).toEqual({ timeout: 60000, retries: 2 });

    const loop = roundTripped.nodes.find(n => n.id === 'the-loop');
    expect(loop.size).toEqual({ width: 520, height: 300 });

    const child = roundTripped.nodes.find(n => n.id === 'analyze');
    expect(child.parentId).toBe('the-loop');

    const e3 = roundTripped.edges.find(e => e.id === 'e3');
    expect(e3.sourceHandle).toBe('true');
    expect(e3.condition).toEqual({ type: 'equals', field: 'result.branch', value: 'true' });
    expect(e3.label).toEqual({ en: 'done' });

    // Edges without a real condition stay condition-free
    const e1 = roundTripped.edges.find(e => e.id === 'e1');
    expect(e1.condition).toBeUndefined();
  });
});

describe('new loop and step options survive an editor round-trip', () => {
  it('keeps itemVariable, countInto, and a step progress note', () => {
    const wf = JSON.parse(JSON.stringify(containerWorkflow));
    const loop = wf.nodes.find(n => n.id === 'the-loop');
    loop.config.itemVariable = '_currentDoc';
    loop.config.countInto = 'coverage.processed';
    wf.nodes.find(n => n.id === 'analyze').config.progress = {
      message: 'Reading {{_currentDoc.title}}',
      when: '$.data._currentDoc.truncated === true'
    };

    const { nodes, edges } = workflowToFlow(wf);
    const out = flowToWorkflow(nodes, edges, wf);

    const outLoop = out.nodes.find(n => n.id === 'the-loop');
    expect(outLoop.config.itemVariable).toBe('_currentDoc');
    expect(outLoop.config.countInto).toBe('coverage.processed');
    expect(out.nodes.find(n => n.id === 'analyze').config.progress).toEqual({
      message: 'Reading {{_currentDoc.title}}',
      when: '$.data._currentDoc.truncated === true'
    });
  });

  it('offers the named item to steps inside the loop', () => {
    const wf = JSON.parse(JSON.stringify(containerWorkflow));
    wf.nodes.find(n => n.id === 'the-loop').config.itemVariable = '_currentDoc';
    const { nodes, edges } = workflowToFlow(wf);
    const names = collectUpstreamVariables(nodes, edges, 'analyze').map(s => s.value);
    expect(names).toContain('_currentDoc');
  });

  it('offers both named items to a step inside a nested loop', () => {
    const wf = JSON.parse(JSON.stringify(containerWorkflow));
    wf.nodes.find(n => n.id === 'the-loop').config.itemVariable = '_subQuestion';
    wf.nodes.push({
      id: 'inner-loop',
      type: 'loop',
      name: { en: 'Per document' },
      position: { x: 20, y: 40 },
      parentId: 'the-loop',
      config: { mode: 'forEach', array: '_corpus', itemVariable: '_currentDoc' }
    });
    wf.nodes.push({
      id: 'inner-step',
      type: 'prompt',
      name: { en: 'Extract' },
      position: { x: 10, y: 20 },
      parentId: 'inner-loop',
      config: {}
    });

    const { nodes, edges } = workflowToFlow(wf);
    const names = collectUpstreamVariables(nodes, edges, 'inner-step').map(s => s.value);
    expect(names).toContain('_currentDoc');
    expect(names).toContain('_subQuestion');
  });
});

describe('collectUpstreamVariables', () => {
  it('offers workflow inputs, upstream outputs, and loop scope to container children', () => {
    const { nodes, edges } = workflowToFlow(containerWorkflow);
    const suggestions = collectUpstreamVariables(nodes, edges, 'analyze');
    const names = suggestions.map(s => s.value);
    expect(names).toContain('topic');
    expect(names).toContain('searchResults');
    expect(names).toContain('_loopItem');
    expect(names).toContain('_loopHuman');
    // A node must not suggest its own output
    expect(names).not.toContain('analysis');
  });

  it('does not offer loop scope to top-level nodes', () => {
    const { nodes, edges } = workflowToFlow(containerWorkflow);
    const names = collectUpstreamVariables(nodes, edges, 'search').map(s => s.value);
    expect(names).not.toContain('_loopItem');
    expect(names).toContain('topic');
  });
});

describe('createNewNode', () => {
  it('creates loop nodes as sized containers with forEach defaults', () => {
    const node = createNewNode('loop', { x: 10, y: 20 });
    expect(node.type).toBe('loopContainer');
    expect(node.width).toBeGreaterThan(0);
    expect(node.data.nodeConfig.mode).toBe('forEach');
    expect(node.data.nodeConfig.outputVariable).toBe('results');
  });

  it('assigns parentId when created inside a container', () => {
    const node = createNewNode('prompt', { x: 5, y: 5 }, 'loop-1');
    expect(node.parentId).toBe('loop-1');
  });
});

describe('parentsFirst', () => {
  it('moves children after their containers', () => {
    const ordered = parentsFirst([
      { id: 'child', parentId: 'box' },
      { id: 'box' },
      { id: 'other' }
    ]);
    expect(ordered.indexOf(ordered.find(n => n.id === 'box'))).toBeLessThan(
      ordered.indexOf(ordered.find(n => n.id === 'child'))
    );
    expect(ordered.map(n => n.id).sort()).toEqual(['box', 'child', 'other']);
  });

  it('places a grandchild after its own parent, not just after the roots', () => {
    // React Flow needs each parent before its children. Two levels of nesting
    // put a grandchild and its parent in the same "has a parentId" bucket, so
    // a plain two-way split can still emit them in the wrong order.
    const ordered = parentsFirst([
      { id: 'outer' },
      { id: 'step', parentId: 'inner' },
      { id: 'inner', parentId: 'outer' }
    ]).map(n => n.id);
    expect(ordered.indexOf('outer')).toBeLessThan(ordered.indexOf('inner'));
    expect(ordered.indexOf('inner')).toBeLessThan(ordered.indexOf('step'));
  });

  it('keeps every node exactly once', () => {
    const input = [
      { id: 'c', parentId: 'b' },
      { id: 'b', parentId: 'a' },
      { id: 'a' },
      { id: 'loose' }
    ];
    const ordered = parentsFirst(input);
    expect(ordered).toHaveLength(4);
    expect(new Set(ordered.map(n => n.id)).size).toBe(4);
  });

  it('does not hang on a parent cycle', () => {
    const ordered = parentsFirst([
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' }
    ]);
    expect(ordered).toHaveLength(2);
  });
});

describe('createStarterWorkflow', () => {
  it('produces a workflow the server schema accepts once an ID is given', () => {
    const result = workflowConfigSchema.safeParse(createStarterWorkflow({ id: 'my-workflow' }));
    expect(result.success).toBe(true);
  });

  it('ships connected start and end steps so a new workflow is valid immediately', () => {
    const wf = createStarterWorkflow();
    expect(wf.nodes.map(n => n.type)).toEqual(['start', 'end']);
    expect(wf.edges).toEqual([{ id: 'e-start-end', source: 'start', target: 'end' }]);
  });

  it('fills name and description, which the schema requires to be non-empty', () => {
    const wf = createStarterWorkflow();
    expect(wf.name.en.length).toBeGreaterThan(0);
    expect(wf.description.en.length).toBeGreaterThan(0);
  });

  it('renders on the canvas with both steps and their connection', () => {
    const { nodes, edges } = workflowToFlow(createStarterWorkflow({ id: 'x' }));
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    // Distinct positions so the two steps do not overlap on the canvas
    expect(nodes[0].position).not.toEqual(nodes[1].position);
  });

  it('lets overrides win over the defaults', () => {
    const wf = createStarterWorkflow({ id: 'abc', name: { en: 'Mine' } });
    expect(wf.id).toBe('abc');
    expect(wf.name).toEqual({ en: 'Mine' });
  });
});
