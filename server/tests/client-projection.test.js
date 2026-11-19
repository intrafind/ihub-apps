// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the browser is sent of a run and of a stored answer
 * (`services/loop/clientProjection.js`): a document tool's arguments, a
 * result's preview and the model's compaction notes stay on the server; the
 * row sources the answer's sources hold go as references.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientEnvelope, clientMessages } from '../services/loop/clientProjection.js';
import { displayDigest, renderDigest } from '../services/loop/findingsDigest.js';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';
import { createStreamState, reduceRunEvents, getRun } from '../../shared/run/runReducer.js';
import { buildToolActivity } from '../../shared/run/toolActivity.js';
import { resolveRowSources } from '../../shared/run/activitySourceRefs.js';

const markdown = `# Daniel Manzke\n\n${'A paragraph of the CV. '.repeat(400)}`;

function envelope(type, data, seq = 1) {
  return { v: 2, seq, runId: 'run-1', ts: '2026-11-19T00:00:00.000Z', type, data };
}

const started = envelope(SSE_V2_EVENTS.TOOL_STARTED, {
  step: 1,
  callId: 'c1',
  toolId: 'create_pdf',
  name: 'create_pdf',
  args: { filename: 'cv', markdown, toc: true },
  execution: 'server'
});

test('tool/started: a document in the arguments is cut to what the row lists', () => {
  const sent = clientEnvelope(started);
  assert.equal(sent.data.args.filename, 'cv');
  assert.equal(sent.data.args.toc, true);
  assert.equal(sent.data.args.markdown, `${markdown.slice(0, 160)}…`);
  // The producer's frame is left as it is (the `/v1` APIs read it).
  assert.equal(started.data.args.markdown, markdown);
  assert.ok(JSON.stringify(sent).length < 1000);
});

test('tool/started: the row the browser builds lists the same details', () => {
  const rowOf = frames => {
    const state = reduceRunEvents(createStreamState(), [
      envelope(SSE_V2_EVENTS.RUN_STARTED, { kind: 'chat', refs: {} }, 1),
      ...frames
    ]);
    return buildToolActivity(getRun(state, 'run-1')).items[0];
  };
  const full = rowOf([{ ...started, seq: 2 }]);
  const cut = rowOf([{ ...clientEnvelope(started), seq: 2 }]);
  assert.deepEqual(cut.details, full.details);
});

test('tool/started: an MCP App view gets the whole input', () => {
  const view = envelope(SSE_V2_EVENTS.TOOL_STARTED, {
    ...started.data,
    mcpApp: { serverId: 's', toolName: 't', resourceUri: 'ui://v' }
  });
  assert.equal(clientEnvelope(view), view);
});

test('tool/completed: only whether a page read hit the cap is sent of the preview', () => {
  const done = data =>
    clientEnvelope(
      envelope(SSE_V2_EVENTS.TOOL_COMPLETED, {
        step: 1,
        callId: 'c1',
        toolId: 'read_url',
        name: 'read_url',
        ...data
      })
    ).data;
  assert.equal(done({ resultPreview: '{"results":[…]}' }).resultPreview, null);
  assert.equal(done({ resultPreview: { results: ['sunny'] } }).resultPreview, null);
  assert.deepEqual(
    done({ resultPreview: { limitReached: true, code: 'PAGE_READ_LIMIT_REACHED', message: 'x' } })
      .resultPreview,
    { limitReached: true }
  );
  assert.deepEqual(
    done({ resultPreview: null, error: { message: 'down' } }).error,
    { message: 'down' },
    'the error is its own field'
  );
});

test('step/completed: the call records go without their arguments', () => {
  const sent = clientEnvelope(
    envelope(SSE_V2_EVENTS.STEP_COMPLETED, {
      step: 1,
      content: '',
      toolCalls: [
        {
          id: 'c1',
          index: 0,
          type: 'function',
          name: 'create_pdf',
          arguments: JSON.stringify({ markdown }),
          metadata: { originalFormat: 'vllm' }
        }
      ],
      finishReason: 'tool_calls'
    })
  );
  assert.deepEqual(sent.data.toolCalls, [
    { id: 'c1', index: 0, type: 'function', name: 'create_pdf' }
  ]);
  assert.equal(sent.data.finishReason, 'tool_calls');
});

const digest = renderDigest({
  number: 1,
  calls: [
    {
      ref: 'r1',
      name: 'braveSearch',
      args: '{"query":"Daniel Manzke"}',
      sources: [{ title: 'LinkedIn', url: 'https://www.linkedin.com/in/x/' }]
    }
  ],
  facts: [{ ref: 'r1', text: 'Head of Engineering at IntraFind', source: 'linkedin.com' }],
  notFound: [{ ref: 'r1', text: 'date of birth' }]
}).text;

test('displayDigest: the facts a person reads, without the instructions and the calls', () => {
  const shown = displayDigest(digest);
  assert.deepEqual(shown, {
    digest:
      'Facts:\n- [r1] Head of Engineering at IntraFind (linkedin.com)\n\n' +
      'Looked for, not found:\n- [r1] date of birth',
    truncated: false
  });
  assert.deepEqual(displayDigest(shown.digest), shown, 'applying it again changes nothing');
});

test('displayDigest: notes without facts keep their calls; long notes are cut', () => {
  const callsOnly = renderDigest({
    number: 1,
    calls: [{ ref: 'r1', name: 'braveSearch', args: '{}', sources: [] }]
  }).text;
  assert.equal(displayDigest(callsOnly).digest, 'Calls:\n- r1 · braveSearch · {} · ok');
  const long = displayDigest('n'.repeat(5000));
  assert.equal(long.truncated, true);
  assert.equal(long.digest.length, 2001);
  assert.equal(displayDigest(''), null);
});

test('context/compacted: the notes are sent as a person reads them', () => {
  const sent = clientEnvelope(
    envelope(SSE_V2_EVENTS.CONTEXT_COMPACTED, {
      compactionId: 'cmp-1',
      step: 3,
      status: 'completed',
      trigger: 'proactive',
      strategy: 'digest',
      lossy: false,
      itemsSummarised: 1,
      digest
    })
  );
  assert.equal(sent.data.digest, displayDigest(digest).digest);
  assert.equal(sent.data.digestTruncated, undefined);
});

function storedAnswer() {
  const linkedin = {
    id: 'url:linkedin.com/in/x',
    provider: 'web',
    kind: 'page',
    url: 'https://www.linkedin.com/in/x/',
    title: 'LinkedIn',
    origin: { kind: 'web' },
    read: { ok: true },
    private: false
  };
  const other = {
    id: 'url:example.com',
    provider: 'web',
    kind: 'page',
    url: 'https://example.com/',
    title: 'Example',
    origin: { kind: 'web' },
    private: false
  };
  return {
    id: 'm2',
    role: 'assistant',
    content: 'Answer',
    sources: {
      items: [
        { ...linkedin, favicon: 'https://favicon/x', snippet: 'Head of Engineering…' },
        { ...other, favicon: 'https://favicon/e', snippet: 'Example…' }
      ],
      queries: []
    },
    activity: {
      toolActivity: {
        reading: null,
        items: [
          {
            id: 'c1',
            kind: 'search',
            name: 'braveSearch',
            status: 'completed',
            query: 'Daniel Manzke',
            details: [],
            // The second was read in this call only: it differs from the answer's entry.
            sources: [linkedin, { ...other, read: { ok: true } }]
          },
          {
            id: 'c2',
            kind: 'tool',
            name: 'Create PDF',
            status: 'completed',
            details: [
              {
                name: 'markdown',
                values: [{ text: `${markdown.slice(0, 160)}…`, full: markdown }],
                more: 0
              }
            ],
            sources: []
          },
          { id: 'cmp', kind: 'compaction', name: '', status: 'completed', digest, sources: [] }
        ]
      }
    }
  };
}

test('stored answer: no uncut arguments, the notes for a person, row sources by reference', () => {
  const stored = storedAnswer();
  const [user, sent] = clientMessages([{ id: 'm1', role: 'user', content: 'Who?' }, stored]);
  assert.deepEqual(user, { id: 'm1', role: 'user', content: 'Who?' });
  const [search, pdf, compaction] = sent.activity.toolActivity.items;
  assert.deepEqual(pdf.details[0].values, [{ text: `${markdown.slice(0, 160)}…` }]);
  assert.equal(compaction.digest, displayDigest(digest).digest);
  assert.deepEqual(search.sources[0], { id: 'url:linkedin.com/in/x' });
  assert.equal(search.sources[1].read.ok, true, 'a source that differs is sent as it is');
  // The stored message is not changed.
  assert.equal(stored.activity.toolActivity.items[1].details[0].values[0].full, markdown);

  // The client puts the row sources back as they were.
  const restored = resolveRowSources(sent.activity, sent.sources);
  assert.deepEqual(
    restored.toolActivity.items[0].sources,
    stored.activity.toolActivity.items[0].sources
  );
});

test('stored answer: a message without activity rows is passed through', () => {
  const plain = { id: 'm', role: 'assistant', content: 'x', sources: { items: [] } };
  assert.equal(clientMessages([plain])[0], plain);
  assert.equal(clientMessages(undefined), undefined);
});
