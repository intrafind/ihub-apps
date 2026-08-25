import { describe, it, expect } from '@jest/globals';
import {
  workflowToFlow,
  flowToWorkflow,
  collectUpstreamVariables,
  createNewNode,
  parentsFirst
} from '../../../client/src/features/workflows/editor/workflowEditorUtils.js';

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
    expect(ordered.map(n => n.id)).toEqual(['box', 'other', 'child']);
  });
});
