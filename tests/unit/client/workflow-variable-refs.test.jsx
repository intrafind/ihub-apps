import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  workflowToFlow,
  findUnknownReferences,
  variablesProducedBy,
  variablesScopedToContainer,
  collectUpstreamVariables
} from '../../../client/src/features/workflows/editor/workflowEditorUtils.js';

const DIR = path.resolve(process.cwd(), 'server/defaults/workflows');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const load = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8'));

describe('variablesProducedBy', () => {
  it('reports what each kind of step writes, not just outputVariable', () => {
    const { nodes } = workflowToFlow({
      id: 'w',
      name: { en: 'w' },
      description: { en: 'd' },
      version: '1.0.0',
      nodes: [
        {
          id: 'start',
          type: 'start',
          name: { en: 'Start' },
          position: { x: 0, y: 0 },
          config: { inputVariables: [{ name: 'topic', type: 'string' }], defaults: { budget: 3 } }
        },
        {
          id: 'search',
          type: 'corpus-search',
          name: { en: 'Search' },
          position: { x: 1, y: 0 },
          config: { corpusVar: '_corpus' }
        },
        {
          id: 'loop',
          type: 'loop',
          name: { en: 'Each' },
          position: { x: 2, y: 0 },
          config: { mode: 'forEach', array: '_corpus', itemVariable: '_doc', countInto: 'cov.done' }
        },
        { id: 'end', type: 'end', name: { en: 'End' }, position: { x: 3, y: 0 }, config: {} }
      ],
      edges: []
    });
    const names = id => variablesProducedBy(nodes.find(n => n.id === id)).map(v => v.name);

    expect(names('start')).toEqual(expect.arrayContaining(['topic', 'budget']));
    expect(names('search')).toEqual(expect.arrayContaining(['_corpus', '_coverage']));
    // A counter path contributes its root, which is what a reference resolves
    // against. The named item does NOT: it is loop-scoped, so it belongs to
    // the steps inside the loop rather than to the workflow.
    expect(names('loop')).toEqual(expect.arrayContaining(['cov']));
    expect(names('loop')).not.toContain('_doc');
    expect(variablesScopedToContainer(nodes.find(n => n.id === 'loop')).map(v => v.name)).toEqual([
      '_doc'
    ]);
  });
});

describe('loop-scoped names stay inside their loop', () => {
  const wf = {
    id: 'w',
    name: { en: 'w' },
    description: { en: 'd' },
    version: '1.0.0',
    nodes: [
      { id: 'start', type: 'start', name: { en: 'S' }, position: { x: 0, y: 0 }, config: {} },
      {
        id: 'loop',
        type: 'loop',
        name: { en: 'Each' },
        position: { x: 1, y: 0 },
        config: { mode: 'forEach', array: 'items', itemVariable: '_doc' }
      },
      {
        id: 'inside',
        type: 'prompt',
        name: { en: 'Inside' },
        position: { x: 0, y: 0 },
        parentId: 'loop',
        config: { prompt: { en: 'Read {{_doc.title}}' } }
      },
      {
        id: 'after',
        type: 'prompt',
        name: { en: 'After' },
        position: { x: 2, y: 0 },
        config: { prompt: { en: 'Summarize {{_doc.title}}' } }
      },
      { id: 'end', type: 'end', name: { en: 'E' }, position: { x: 3, y: 0 }, config: {} }
    ],
    edges: [
      { id: 'a', source: 'start', target: 'loop' },
      { id: 'b', source: 'loop', target: 'after' }
    ]
  };

  it('offers the item to a step inside the loop', () => {
    const { nodes, edges } = workflowToFlow(wf);
    expect(collectUpstreamVariables(nodes, edges, 'inside').map(v => v.value)).toContain('_doc');
  });

  it('does not offer it to a step after the loop', () => {
    const { nodes, edges } = workflowToFlow(wf);
    expect(collectUpstreamVariables(nodes, edges, 'after').map(v => v.value)).not.toContain('_doc');
  });

  it('warns when a step outside the loop reads the item, but not when one inside does', () => {
    const { nodes, edges } = workflowToFlow(wf);
    const problems = findUnknownReferences(nodes, edges);
    expect(problems.map(p => p.nodeId)).toEqual(['after']);
    expect(problems[0].name).toBe('_doc');
  });
});

describe('findUnknownReferences on the shipped workflows', () => {
  it.each(files)('%s references only variables some step defines', file => {
    const { nodes, edges } = workflowToFlow(load(file));
    const unknown = findUnknownReferences(nodes, edges).map(p => `${p.nodeId} -> {{${p.name}}}`);
    expect(unknown).toEqual([]);
  });
});

describe('findUnknownReferences catches real mistakes', () => {
  const base = {
    id: 'w',
    name: { en: 'w' },
    description: { en: 'd' },
    version: '1.0.0',
    nodes: [
      {
        id: 'start',
        type: 'start',
        name: { en: 'Start' },
        position: { x: 0, y: 0 },
        config: { inputVariables: [{ name: 'topic', type: 'string' }] }
      },
      {
        id: 'write',
        type: 'prompt',
        name: { en: 'Write' },
        position: { x: 1, y: 0 },
        config: { prompt: { en: 'About {{topic}}' }, outputVariable: 'draft' }
      },
      { id: 'end', type: 'end', name: { en: 'End' }, position: { x: 2, y: 0 }, config: {} }
    ],
    edges: [
      { id: 'a', source: 'start', target: 'write' },
      { id: 'b', source: 'write', target: 'end' }
    ]
  };

  it('accepts a workflow whose references all resolve', () => {
    const { nodes, edges } = workflowToFlow(base);
    expect(findUnknownReferences(nodes, edges)).toEqual([]);
  });

  it('flags a typo in a prompt template', () => {
    const wf = JSON.parse(JSON.stringify(base));
    wf.nodes[1].config.prompt.en = 'About {{topci}}';
    const { nodes, edges } = workflowToFlow(wf);
    const found = findUnknownReferences(nodes, edges);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'write', name: 'topci' });
  });

  it('flags a stale $.data reference in an edge condition', () => {
    const wf = JSON.parse(JSON.stringify(base));
    wf.edges[1].condition = { type: 'expression', expression: '$.data.oldName === true' };
    const { nodes, edges } = workflowToFlow(wf);
    expect(findUnknownReferences(nodes, edges).map(p => p.name)).toEqual(['oldName']);
  });

  it('does not flag Handlebars block names or loop scope', () => {
    const wf = JSON.parse(JSON.stringify(base));
    wf.nodes[1].config.prompt.en = '{{#each items}}{{this}}{{/each}} {{_loopHuman}}/{{_loopTotal}}';
    wf.nodes[1].config.outputVariable = 'draft';
    wf.nodes.splice(1, 0, {
      id: 'mk',
      type: 'transform',
      name: { en: 'Make' },
      position: { x: 0, y: 1 },
      config: { operations: [{ set: 'items', value: [] }] }
    });
    const { nodes, edges } = workflowToFlow(wf);
    expect(findUnknownReferences(nodes, edges)).toEqual([]);
  });
});

describe('collectUpstreamVariables uses the same producer knowledge', () => {
  it('offers a corpus search result to a later step', () => {
    const { nodes, edges } = workflowToFlow({
      id: 'w',
      name: { en: 'w' },
      description: { en: 'd' },
      version: '1.0.0',
      nodes: [
        { id: 'start', type: 'start', name: { en: 'S' }, position: { x: 0, y: 0 }, config: {} },
        {
          id: 'search',
          type: 'corpus-search',
          name: { en: 'Search' },
          position: { x: 1, y: 0 },
          config: {}
        },
        { id: 'use', type: 'prompt', name: { en: 'Use' }, position: { x: 2, y: 0 }, config: {} },
        { id: 'end', type: 'end', name: { en: 'E' }, position: { x: 3, y: 0 }, config: {} }
      ],
      edges: [
        { id: 'a', source: 'start', target: 'search' },
        { id: 'b', source: 'search', target: 'use' }
      ]
    });
    const names = collectUpstreamVariables(nodes, edges, 'use').map(v => v.value);
    expect(names).toContain('_corpus');
    expect(names).toContain('_coverage');
  });
});
