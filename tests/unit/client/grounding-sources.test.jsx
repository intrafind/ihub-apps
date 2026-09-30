/**
 * Unit tests for the sources behind a chat answer, live: the reducer's merge
 * of piecemeal grounding frames, and of `sources/added` frames into the run's
 * source set, and the message projection onto `sources` (runToMessage.js over
 * shared/sources).
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

const page = (url, fields = {}) => ({
  id: `url:${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`,
  provider: 'web',
  kind: 'page',
  url,
  private: false,
  ...fields
});

describe('projectRunToMessage — sources', () => {
  test('folds every sources/added frame into one set, in the order found', () => {
    const run = runFrom([
      started,
      env(2, 'tool/started', {
        step: 1,
        callId: 'c1',
        toolId: 'braveSearch',
        name: 'braveSearch',
        args: { query: 'what is a' }
      }),
      env(3, 'tool/completed', {
        step: 1,
        callId: 'c1',
        toolId: 'braveSearch',
        name: 'braveSearch',
        resultPreview: '…'
      }),
      env(4, 'sources/added', {
        step: 1,
        callId: 'c1',
        toolId: 'braveSearch',
        items: [page('https://a.example/page', { title: 'A' }), page('https://b.example/')],
        queries: ['what is a']
      }),
      // Provider search, streamed piece by piece: a citation of a page found above.
      env(5, 'sources/added', {
        step: 2,
        items: [page('https://a.example/page', { passages: [{ text: 'quote a' }], cited: true })]
      }),
      env(6, 'step/completed', {
        step: 2,
        content: 'Answer[1](https://a.example/page)',
        toolCalls: [],
        finishReason: 'stop'
      }),
      env(7, 'run/ended', { status: 'completed', finishReason: 'stop' })
    ]);
    const { extras } = projectRunToMessage(run);
    expect(extras.sources.queries).toEqual(['what is a']);
    expect(extras.sources.items).toEqual([
      page('https://a.example/page', { title: 'A', passages: [{ text: 'quote a' }], cited: true }),
      page('https://b.example/')
    ]);
    // The call that found them lists its own.
    expect(run.tools[0].sources.map(source => source.id)).toEqual([
      'url:a.example/page',
      'url:b.example'
    ]);
  });

  test('shows the sources while the answer still streams', () => {
    const run = runFrom([
      started,
      env(2, 'step/delta', { step: 1, kind: 'text', content: 'Looking…' }),
      env(3, 'sources/added', { step: 1, items: [page('https://a.example/', { title: 'A' })] })
    ]);
    const { extras, loading } = projectRunToMessage(run);
    expect(loading).toBe(true);
    expect(extras.sources.items).toEqual([page('https://a.example/', { title: 'A' })]);
  });

  test('places Google grounding markers after the supported passages', () => {
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc';
    const run = runFrom([
      started,
      env(2, 'step/delta', { step: 1, kind: 'text', content: 'Claim one. Claim two.' }),
      env(3, 'sources/added', {
        step: 1,
        items: [page(redirect, { site: 'g.example', cited: true })],
        queries: ['q'],
        supports: [{ text: 'Claim two.', urls: [redirect] }]
      }),
      env(4, 'step/completed', {
        step: 1,
        content: 'Claim one. Claim two.',
        toolCalls: [],
        finishReason: 'stop'
      }),
      env(5, 'run/ended', { status: 'completed', finishReason: 'stop' })
    ]);
    const { content, extras } = projectRunToMessage(run);
    expect(content).toBe(`Claim one. Claim two.[1](${redirect})`);
    expect(extras.sources.items[0].site).toBe('g.example');
  });

  test('omits the field when nothing was found', () => {
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
    expect(projectRunToMessage(run).extras.sources).toBeUndefined();
  });
});
