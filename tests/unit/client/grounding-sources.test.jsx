/**
 * Unit tests for the sources shown under a grounded chat answer: the
 * extractor (client/src/features/chat/groundingSources.js), the reducer's merge
 * of piecemeal grounding frames and the message projection.
 */
import {
  extractGroundingSources,
  hostnameOf
} from '../../../client/src/features/chat/groundingSources';
import {
  createStreamState,
  reduceRunEvents,
  getRun,
  mergeGrounding
} from '../../../client/src/shared/run/runReducer';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';

const ts = seq => `2026-09-07T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}, runId = 'run-1') => ({
  v: 2,
  seq,
  runId,
  ts: ts(seq),
  type,
  data
});
const started = env(1, 'run/started', {
  kind: 'chat',
  refs: { chatId: 'chat-1', appId: 'app-1', messageId: 'msg-1' }
});

function runFrom(envelopes) {
  return getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');
}

const citationA = {
  type: 'web_search_result_location',
  url: 'https://a.example/page',
  title: 'A',
  cited_text: 'quote a'
};

describe('extractGroundingSources', () => {
  test('prefers Anthropic citations over raw search results and deduplicates by URL', () => {
    const sources = extractGroundingSources({
      searchResults: [
        { type: 'web_search_result', url: 'https://a.example/page', title: 'A' },
        { type: 'web_search_result', url: 'https://b.example', title: 'B' }
      ],
      citations: [citationA, { ...citationA, cited_text: 'second quote from a' }]
    });
    expect(sources).toEqual([{ url: 'https://a.example/page', title: 'A', citedText: 'quote a' }]);
  });

  test('falls back to the search results when nothing was cited', () => {
    const sources = extractGroundingSources({
      searchResults: [
        { url: 'https://a.example', title: 'A' },
        { url: 'https://a.example', title: 'A again' },
        { url: 'https://b.example' }
      ],
      citations: []
    });
    expect(sources).toEqual([
      { url: 'https://a.example', title: 'A' },
      { url: 'https://b.example' }
    ]);
  });

  test('reads Google grounding chunks', () => {
    const sources = extractGroundingSources({
      groundingChunks: [{ web: { uri: 'https://g.example/x', title: 'g.example' } }, { web: {} }],
      webSearchQueries: ['query']
    });
    expect(sources).toEqual([{ url: 'https://g.example/x', title: 'g.example' }]);
  });

  test('merges several metadata objects and ignores junk', () => {
    expect(extractGroundingSources(null)).toEqual([]);
    expect(extractGroundingSources([{ citations: [{}] }, undefined, 'nope'])).toEqual([]);
    expect(
      extractGroundingSources([
        { citations: [citationA] },
        { citations: [{ url: 'https://b.example' }] }
      ])
    ).toEqual([
      { url: 'https://a.example/page', title: 'A', citedText: 'quote a' },
      { url: 'https://b.example' }
    ]);
  });
});

describe('hostnameOf', () => {
  test('strips the scheme, path and a leading www', () => {
    expect(hostnameOf('https://www.example.org/a/b?c=1')).toBe('example.org');
    expect(hostnameOf('not a url')).toBe('not a url');
  });
});

describe('runReducer — grounding frames', () => {
  test('merges piecemeal grounding progress instead of keeping only the last frame', () => {
    const run = runFrom([
      started,
      env(2, 'tool/progress', {
        step: 1,
        phase: 'grounding',
        data: { searchResults: [{ url: 'https://a.example', title: 'A' }], citations: [] }
      }),
      env(3, 'tool/progress', {
        step: 1,
        phase: 'grounding',
        data: { citations: [citationA] }
      })
    ]);
    expect(run.grounding.searchResults).toHaveLength(1);
    expect(run.grounding.citations).toEqual([citationA]);
  });

  test('mergeGrounding concatenates arrays and takes the latest scalar', () => {
    expect(mergeGrounding(null, { a: [1] })).toEqual({ a: [1] });
    expect(mergeGrounding({ a: [1], q: 'old' }, { a: [2], q: 'new' })).toEqual({
      a: [1, 2],
      q: 'new'
    });
    expect(mergeGrounding({ a: [1] }, null)).toEqual({ a: [1] });
  });
});

describe('projectRunToMessage — grounding sources', () => {
  test('projects the cited sources of a completed step', () => {
    const run = runFrom([
      started,
      env(2, 'tool/progress', {
        step: 1,
        phase: 'grounding',
        data: { citations: [citationA] }
      }),
      env(3, 'step/completed', {
        step: 1,
        content: 'Answer',
        toolCalls: [],
        finishReason: 'stop',
        groundingMetadata: {
          searchResults: [
            { url: 'https://a.example/page', title: 'A' },
            { url: 'https://b.example', title: 'B' }
          ],
          citations: [citationA]
        }
      }),
      env(4, 'run/ended', {
        status: 'completed',
        finishReason: 'stop',
        knowledgeSources: ['grounding']
      })
    ]);
    const { extras } = projectRunToMessage(run);
    expect(extras.groundingSources).toEqual([
      { url: 'https://a.example/page', title: 'A', citedText: 'quote a' }
    ]);
    expect(extras.answerSource).toEqual({ sources: ['grounding'], type: 'mixed' });
  });

  test('uses the streamed grounding frames while no step has completed', () => {
    const run = runFrom([
      started,
      env(2, 'step/delta', { step: 1, kind: 'text', content: 'Looking…' }),
      env(3, 'tool/progress', {
        step: 1,
        phase: 'grounding',
        data: { searchResults: [{ url: 'https://a.example', title: 'A' }], citations: [] }
      })
    ]);
    const { extras, loading } = projectRunToMessage(run);
    expect(loading).toBe(true);
    expect(extras.groundingSources).toEqual([{ url: 'https://a.example', title: 'A' }]);
  });

  test('omits the field when nothing was grounded', () => {
    const run = runFrom([
      started,
      env(2, 'step/completed', {
        step: 1,
        content: 'Plain answer',
        toolCalls: [],
        finishReason: 'stop'
      }),
      env(3, 'run/ended', { status: 'completed', finishReason: 'stop' })
    ]);
    expect(projectRunToMessage(run).extras.groundingSources).toBeUndefined();
  });
});
