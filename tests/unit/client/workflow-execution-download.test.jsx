import { describe, it, expect } from '@jest/globals';
import { executionDownload } from '../../../client/src/features/workflows/utils/executionDownload.js';

/** A finished execution whose last step is the end step with the given output. */
const finishedWith = (output, data = {}) => ({
  completedNodes: ['start', 'end'],
  data: { nodeResults: { end: { status: 'completed', output } }, ...data }
});

describe('the download of a finished execution', () => {
  it('is the answer as it is when it is text, as Markdown', () => {
    expect(executionDownload(finishedWith({ output: '# Report', topic: 'wind' }))).toEqual({
      content: '# Report',
      extension: 'md'
    });
  });

  it('is JSON as JSON', () => {
    expect(executionDownload(finishedWith({ output: { verdict: 'ok' } }))).toEqual({
      content: JSON.stringify({ verdict: 'ok' }, null, 2),
      extension: 'json'
    });
  });

  it('is a number or a boolean as JSON: 0 and false are answers, not the lack of one', () => {
    for (const answer of [0, false, 42, true]) {
      expect(executionDownload(finishedWith({ output: answer }, { topic: 'unrelated' }))).toEqual({
        content: JSON.stringify(answer),
        extension: 'json'
      });
    }
  });

  it('falls back to the state of a run that has no answer: one string field as it is', () => {
    const state = { completedNodes: [], data: { topic: 'wind', nodeResults: {} } };
    expect(executionDownload(state)).toEqual({ content: 'wind', extension: 'md' });
  });

  it('bundles several string fields, and dumps what is not text as JSON', () => {
    const bundle = { completedNodes: [], data: { a: 'A', b: 'B' } };
    expect(executionDownload(bundle)).toEqual({
      content: '# a\n\nA\n\n# b\n\nB',
      extension: 'md'
    });
    const dump = { completedNodes: [], data: { items: [1, 2] } };
    expect(executionDownload(dump)).toEqual({
      content: JSON.stringify({ items: [1, 2] }, null, 2),
      extension: 'json'
    });
  });

  it('is nothing for a run with neither an answer nor any data', () => {
    expect(executionDownload({ completedNodes: [], data: {} })).toBeNull();
    expect(executionDownload(undefined)).toBeNull();
  });
});
