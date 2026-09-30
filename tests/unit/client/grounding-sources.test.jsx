/**
 * Unit tests for the sources behind a grounded chat answer: the reducer's merge
 * of piecemeal grounding frames and the message projection onto `webSearch`
 * (client/src/features/chat/webSearch.js over shared/webCitations.js).
 */
import { hostnameOf } from '../../../shared/run/groundingSources.js';
import {
  createStreamState,
  reduceRunEvents,
  getRun,
  mergeGrounding
} from '../../../shared/run/runReducer.js';
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

describe('projectRunToMessage — web search from grounding', () => {
  test('projects the searched and cited sources of a completed step', () => {
    const run = runFrom([
      started,
      env(2, 'tool/progress', {
        step: 1,
        phase: 'grounding',
        data: { citations: [citationA] }
      }),
      env(3, 'step/completed', {
        step: 1,
        content: 'Answer[1](https://a.example/page)',
        toolCalls: [],
        finishReason: 'stop',
        groundingMetadata: {
          webSearchQueries: ['what is a'],
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
    expect(extras.webSearch.queries).toEqual(['what is a']);
    expect(extras.webSearch.sources).toEqual([
      { url: 'https://a.example/page', title: 'A', citedText: 'quote a', cited: true },
      { url: 'https://b.example/', title: 'B' }
    ]);
    expect(extras.groundingSources).toBeUndefined();
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
    expect(extras.webSearch.sources).toEqual([{ url: 'https://a.example/', title: 'A' }]);
  });

  test('places Google grounding markers after the supported passages', () => {
    const run = runFrom([
      started,
      env(2, 'step/delta', { step: 1, kind: 'text', content: 'Claim one. Claim two.' }),
      env(3, 'step/completed', {
        step: 1,
        content: 'Claim one. Claim two.',
        toolCalls: [],
        finishReason: 'stop',
        groundingMetadata: {
          webSearchQueries: ['q'],
          groundingChunks: [
            {
              web: {
                uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
                title: 'g.example'
              }
            }
          ],
          webSupports: [
            {
              text: 'Claim two.',
              urls: ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc']
            }
          ]
        }
      }),
      env(4, 'run/ended', { status: 'completed', finishReason: 'stop' })
    ]);
    const { content, extras } = projectRunToMessage(run);
    expect(content).toBe(
      'Claim one. Claim two.[1](https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc)'
    );
    expect(extras.webSearch.sources[0].host).toBe('g.example');
  });

  test('omits the field when nothing was searched', () => {
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
    expect(projectRunToMessage(run).extras.webSearch).toBeUndefined();
  });
});
