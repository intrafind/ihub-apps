import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const emitted = [];
jest.mock('../../../../server/actionTracker.js', () => ({
  __esModule: true,
  actionTracker: {
    emit: (channel, payload) => emitted.push({ channel, payload })
  }
}));

import {
  emitNodeProgress,
  resolveProgressTemplate
} from '../../../../server/services/workflow/nodeProgress.js';

const context = { executionId: 'run-1' };

describe('resolveProgressTemplate', () => {
  it('substitutes plain and nested paths', () => {
    const out = resolveProgressTemplate('{{n}}/{{total}} — {{doc.title}}', {
      n: 2,
      total: 5,
      doc: { title: 'Report' }
    });
    expect(out).toBe('2/5 — Report');
  });

  it('renders missing values as empty rather than "undefined"', () => {
    expect(resolveProgressTemplate('x{{nope}}y', {})).toBe('xy');
  });
});

describe('emitNodeProgress', () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  it('emits the note a node declares', () => {
    const node = { id: 'n1', config: { progress: { message: 'Loading {{doc.title}}' } } };
    const sent = emitNodeProgress(node, { data: { doc: { title: 'A' } } }, context);
    expect(sent).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toMatchObject({
      event: 'workflow.node.progress',
      nodeId: 'n1',
      message: 'Loading A',
      status: 'running'
    });
  });

  it('skips the note when its condition is false', () => {
    const node = {
      id: 'n2',
      config: { progress: { message: 'truncated!', when: '$.data.doc.truncated === true' } }
    };
    expect(emitNodeProgress(node, { data: { doc: { truncated: false } } }, context)).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('emits the note when its condition holds', () => {
    const node = {
      id: 'n3',
      config: { progress: { message: 'truncated!', when: '$.data.doc.truncated === true' } }
    };
    expect(emitNodeProgress(node, { data: { doc: { truncated: true } } }, context)).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it('ignores nodes without a note, and the legacy string form on progress nodes', () => {
    expect(emitNodeProgress({ id: 'a', config: {} }, { data: {} }, context)).toBe(false);
    // A standalone `progress` node carries a string here — that is its own
    // message, not a node-level note, and must not be emitted twice.
    expect(
      emitNodeProgress({ id: 'b', config: { progress: 'legacy' } }, { data: {} }, context)
    ).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});

describe('progress notes and chatVisible', () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  it('shows the note even when the step itself is hidden from chat', () => {
    // This pairing is deliberate: the mechanical step stays out of the step
    // list while its one meaningful line still reaches the reader.
    const node = {
      id: 'fetch-doc',
      config: { chatVisible: false, progress: { message: 'Loading {{doc.title}}' } }
    };
    expect(emitNodeProgress(node, { data: { doc: { title: 'A' } } }, context)).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.message).toBe('Loading A');
  });
});
