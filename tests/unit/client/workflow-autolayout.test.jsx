import { describe, it, expect } from '@jest/globals';
import {
  workflowToFlow,
  applyDagreLayout
} from '../../../client/src/features/workflows/editor/workflowEditorUtils.js';

const node = (id, type, extra = {}) => ({
  id,
  type,
  name: { en: id },
  position: { x: 0, y: 0 },
  config: {},
  ...extra
});

/** Nested containers: outer loop holds a step and an inner loop with two steps. */
const nested = {
  id: 'wf',
  name: { en: 'wf' },
  description: { en: 'x' },
  version: '1.0.0',
  nodes: [
    node('start', 'start'),
    node('outer', 'loop', { config: { mode: 'forEach', array: 'items' } }),
    node('outer-a', 'prompt', { parentId: 'outer' }),
    node('inner', 'loop', { parentId: 'outer', config: { mode: 'forEach', array: 'sub' } }),
    node('inner-a', 'prompt', { parentId: 'inner' }),
    node('inner-b', 'prompt', { parentId: 'inner' }),
    node('end', 'end')
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'outer' },
    { id: 'e2', source: 'outer', target: 'end' },
    { id: 'e3', source: 'outer-a', target: 'inner' },
    { id: 'e4', source: 'inner-a', target: 'inner-b' }
  ]
};

const byId = (arr, id) => arr.find(n => n.id === id);

describe('applyDagreLayout with loop containers', () => {
  it('positions the steps inside a container instead of leaving them stacked', () => {
    const { nodes, edges } = workflowToFlow(nested);
    // Every body step starts at the same spot — the bug this guards against is
    // layout leaving them there, overlapping each other.
    const laid = applyDagreLayout(nodes, edges);
    const a = byId(laid, 'inner-a').position;
    const b = byId(laid, 'inner-b').position;
    expect(a).not.toEqual(b);
    // Connected siblings flow left to right.
    expect(b.x).toBeGreaterThan(a.x);
  });

  it('grows a container to fit the steps it holds', () => {
    const { nodes, edges } = workflowToFlow(nested);
    const laid = applyDagreLayout(nodes, edges);
    const outer = byId(laid, 'outer');
    const inner = byId(laid, 'inner');

    for (const child of ['inner-a', 'inner-b']) {
      const p = byId(laid, child).position;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + 200).toBeLessThanOrEqual(inner.width);
      expect(p.y + 80).toBeLessThanOrEqual(inner.height);
    }
    // The outer container must be big enough to hold the inner one.
    const innerPos = byId(laid, 'inner').position;
    expect(innerPos.x + inner.width).toBeLessThanOrEqual(outer.width);
    expect(innerPos.y + inner.height).toBeLessThanOrEqual(outer.height);
  });

  it('keeps body steps clear of the container header', () => {
    const { nodes, edges } = workflowToFlow(nested);
    const laid = applyDagreLayout(nodes, edges);
    for (const id of ['outer-a', 'inner', 'inner-a', 'inner-b']) {
      expect(byId(laid, id).position.y).toBeGreaterThan(24);
    }
  });

  it('still lays out a flat workflow left to right', () => {
    const flat = {
      ...nested,
      nodes: [node('start', 'start'), node('mid', 'prompt'), node('end', 'end')],
      edges: [
        { id: 'a', source: 'start', target: 'mid' },
        { id: 'b', source: 'mid', target: 'end' }
      ]
    };
    const { nodes, edges } = workflowToFlow(flat);
    const laid = applyDagreLayout(nodes, edges);
    expect(byId(laid, 'mid').position.x).toBeGreaterThan(byId(laid, 'start').position.x);
    expect(byId(laid, 'end').position.x).toBeGreaterThan(byId(laid, 'mid').position.x);
  });

  it('leaves an empty container at its default size', () => {
    const empty = {
      ...nested,
      nodes: [
        node('start', 'start'),
        node('loop', 'loop', { config: { mode: 'forEach', array: 'x' } }),
        node('end', 'end')
      ],
      edges: [
        { id: 'a', source: 'start', target: 'loop' },
        { id: 'b', source: 'loop', target: 'end' }
      ]
    };
    const { nodes, edges } = workflowToFlow(empty);
    const laid = applyDagreLayout(nodes, edges);
    expect(byId(laid, 'loop').width).toBe(520);
    expect(byId(laid, 'loop').height).toBe(300);
  });
});
