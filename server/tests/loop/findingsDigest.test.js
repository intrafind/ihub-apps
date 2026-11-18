// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Findings digest (#3819): the pure parts — which batches are cut, how the
 * summary output is parsed and checked against the results, how the digest
 * goes into the transcript — and the summary calls with a fake model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDENSED_PREFIX,
  MIN_CONDENSE_CHARS,
  RECALL_TOOL_ID,
  keepsVerbatim,
  applyDigest,
  chunkCalls,
  collectCalls,
  condensedStateOf,
  extractSources,
  findToolBatches,
  isCondensedContent,
  kindsOf,
  numbersAppearIn,
  parseDigestLines,
  recallPage,
  recallToolDefinition,
  renderDigest,
  selectBatches,
  stripThinking,
  summarizeCalls,
  summaryFailureOf,
  taskOf,
  verifyDigest
} from '../../services/loop/findingsDigest.js';

const big = label =>
  JSON.stringify({
    results: [{ title: label, url: `https://x.test/${label}`, snippet: 'y'.repeat(8000) }]
  });

function call(id, name = 'webSearch', args = { query: id }) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** system, user, then `n` single-call batches with large results, one parallel batch in the middle. */
function transcript() {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'Compare the market caps of NVIDIA and Apple.' },
    { role: 'assistant', content: '', tool_calls: [call('c1')] },
    { role: 'tool', tool_call_id: 'c1', name: 'webSearch', content: big('nvidia') },
    // a parallel batch: two calls, two results — taken together or not at all
    {
      role: 'assistant',
      content: '',
      tool_calls: [call('c2'), call('c3', 'read_url', { url: 'u' })]
    },
    { role: 'tool', tool_call_id: 'c2', name: 'webSearch', content: big('apple') },
    { role: 'tool', tool_call_id: 'c3', name: 'read_url', content: big('page') },
    { role: 'user', content: 'nudge', _nudge: true },
    { role: 'assistant', content: '', tool_calls: [call('c4')] },
    { role: 'tool', tool_call_id: 'c4', name: 'webSearch', content: big('meta') },
    { role: 'assistant', content: '', tool_calls: [call('c5')] },
    { role: 'tool', tool_call_id: 'c5', name: 'webSearch', content: big('tesla') }
  ];
}

test('batches: an assistant message with tool calls and every result up to the next assistant message', () => {
  const batches = findToolBatches(transcript());
  assert.equal(batches.length, 4);
  assert.deepEqual(batches[1].toolIndexes, [5, 6]);
  assert.equal(batches[1].calls.length, 2);
});

test('the cut takes whole batches, oldest first, and never the newest ones', () => {
  const messages = transcript();
  const { batches } = selectBatches(messages, {
    tokensBefore: 100_000,
    targetTokens: 0,
    keepRecentBatches: 2
  });
  assert.deepEqual(
    batches.map(b => b.assistantIndex),
    [2, 4],
    'the two newest batches are kept'
  );
  const calls = collectCalls(messages, batches, { nextRef: 1 });
  assert.deepEqual(
    calls.map(c => [c.ref, c.callId, c.name]),
    [
      ['r1', 'c1', 'webSearch'],
      ['r2', 'c2', 'webSearch'],
      ['r3', 'c3', 'read_url']
    ],
    'both results of the parallel batch'
  );
});

test('the cut stops once the projected prompt is at the target, and keeps at least the newest batch', () => {
  const messages = transcript();
  const first = selectBatches(messages, {
    tokensBefore: 10_000,
    targetTokens: 9_000,
    keepRecentBatches: 0
  });
  assert.equal(first.batches.length, 1, 'one batch is enough');
  const all = selectBatches(messages, { tokensBefore: 1e9, targetTokens: 0, keepRecentBatches: 0 });
  assert.equal(all.batches.length, 3, 'the newest batch is never condensed');
});

test('a condensed batch is not taken again', () => {
  const messages = transcript();
  messages[3] = { ...messages[3], content: `${CONDENSED_PREFIX}r1 of webSearch …]` };
  const { batches } = selectBatches(messages, {
    tokensBefore: 1e9,
    targetTokens: 0,
    keepRecentBatches: 1
  });
  assert.deepEqual(
    batches.map(b => b.assistantIndex),
    [4, 8]
  );
});

test('sources are found by shape in JSON, else as URLs in the text', () => {
  assert.deepEqual(
    extractSources(
      JSON.stringify({
        items: [
          { title: 'A', link: 'https://a.test/1' },
          { name: 'B', url: 'https://b.test' }
        ]
      })
    ),
    [
      { title: 'A', url: 'https://a.test/1' },
      { title: 'B', url: 'https://b.test' }
    ]
  );
  assert.deepEqual(extractSources('see https://c.test/x, and https://c.test/x.'), [
    { title: null, url: 'https://c.test/x' }
  ]);
});

test('summary output: FACT and NOTFOUND lines, anything else ignored, reasoning stripped, repeats kept once', () => {
  const output = [
    '<think>Let me look at r1 … FACT | r9 | invented | x</think>',
    'Here are the facts:',
    '- FACT | r1 | NVIDIA market cap 5.1 trillion USD (2026-11-17) | https://x.test/nvidia',
    '- FACT | r1 | NVIDIA market cap 5.1 trillion USD (2026-11-17) | https://x.test/nvidia',
    'FACT | [r2] | Apple | revenue | 391 bn USD | Apple 10-K',
    'NOTFOUND | r2 | Apple P/E for Q3 2026',
    'FACT | no ref | x'
  ].join('\n');
  const { facts, notFound } = parseDigestLines(output);
  assert.equal(facts.length, 2);
  assert.deepEqual(facts[0], {
    ref: 'r1',
    text: 'NVIDIA market cap 5.1 trillion USD (2026-11-17)',
    source: 'https://x.test/nvidia'
  });
  assert.equal(facts[1].text, 'Apple | revenue | 391 bn USD', 'a fact may hold a pipe');
  assert.equal(facts[1].source, 'Apple 10-K');
  assert.deepEqual(notFound, [{ ref: 'r2', text: 'Apple P/E for Q3 2026' }]);
  assert.equal(stripThinking('a<think>never closed'), 'a');
});

test('verification: numbers must be in the cited result; an invented URL is dropped, an unknown ref is', () => {
  const content = 'NVIDIA: market cap $5,100,000,000,000 as of 17.11.2026 — https://x.test/nvidia';
  assert.ok(numbersAppearIn('5.1 trillion', content) === false, 'a converted number is not found');
  assert.ok(numbersAppearIn('$5,100,000,000,000 on 2026-11-17', content));
  assert.ok(numbersAppearIn('5.100.000.000.000', content), 'separators differ');
  const calls = new Map([['r1', { ref: 'r1', content }]]);
  const verified = verifyDigest(
    {
      facts: [
        {
          ref: 'r1',
          text: 'NVIDIA market cap $5,100,000,000,000',
          source: 'https://x.test/nvidia'
        },
        { ref: 'r1', text: 'NVIDIA P/E 48.2', source: null },
        { ref: 'r1', text: 'NVIDIA is a chip maker', source: 'https://invented.test' },
        { ref: 'r7', text: 'unknown ref', source: null }
      ],
      notFound: [
        { ref: 'r1', text: 'P/E' },
        { ref: 'r9', text: 'nothing' }
      ]
    },
    calls
  );
  assert.deepEqual(
    verified.facts.map(f => [f.text, f.source]),
    [
      ['NVIDIA market cap $5,100,000,000,000', 'https://x.test/nvidia'],
      ['NVIDIA is a chip maker', null]
    ]
  );
  assert.equal(verified.notFound.length, 1);
  assert.equal(verified.dropped, 3);
});

test('summarizeCalls: one call per chunk with the task; facts kept with their sources (fake model)', async () => {
  const messages = transcript();
  const { batches } = selectBatches(messages, { tokensBefore: 1e9, targetTokens: 0 });
  const calls = collectCalls(messages, batches, { nextRef: 1 });
  calls[0].content = JSON.stringify({
    results: [
      {
        title: 'NVIDIA',
        url: 'https://x.test/nvidia',
        snippet: 'Market cap 5.1 trillion USD on 17 Nov 2026'
      }
    ]
  });
  const seen = [];
  const llmClient = {
    complete: async params => {
      seen.push(params);
      return {
        content:
          'FACT | r1 | NVIDIA market cap 5.1 trillion USD on 17 Nov 2026 | https://x.test/nvidia\n' +
          'FACT | r1 | NVIDIA market cap 7.9 trillion USD | https://x.test/nvidia\n' +
          'NOTFOUND | r2 | Apple market cap',
        usage: { promptTokens: 1000, completionTokens: 50 }
      };
    }
  };
  const summary = await summarizeCalls({
    llmClient,
    model: { id: 'm', contextWindow: 200_000 },
    calls,
    task: taskOf(messages),
    timeoutMs: 1000,
    options: { user: { id: 'u1' } },
    telemetry: { purpose: 'context-compaction' }
  });
  assert.equal(seen.length, 1, 'one chunk');
  assert.match(seen[0].messages[1].content, /Compare the market caps/, 'the task as a hint');
  assert.match(seen[0].messages[1].content, /\[r1\] webSearch/);
  assert.equal(seen[0].options.thinkingEnabled, false);
  assert.deepEqual(seen[0].options.user, { id: 'u1' });
  assert.equal(seen[0].timeoutMs, 1000);
  assert.deepEqual(
    summary.facts.map(f => f.text),
    ['NVIDIA market cap 5.1 trillion USD on 17 Nov 2026'],
    'the invented figure is dropped'
  );
  assert.equal(summary.dropped, 1);
  assert.equal(summary.notFound.length, 1);
  assert.deepEqual(summary.usage, { promptTokens: 1000, completionTokens: 50 });
  assert.equal(summaryFailureOf(summary, calls), null);
});

test('summarizeCalls: a failed chunk is reported, an abort of the run is thrown', async () => {
  const calls = collectCalls(transcript(), findToolBatches(transcript()).slice(0, 2), {
    nextRef: 1
  });
  const failing = { complete: async () => Promise.reject(new Error('timeout')) };
  const summary = await summarizeCalls({ llmClient: failing, model: { id: 'm' }, calls });
  assert.equal(summary.failedChunks, summary.chunks);
  assert.equal(summaryFailureOf(summary, calls), 'summary_failed');

  const controller = new AbortController();
  const aborting = {
    complete: async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
  };
  await assert.rejects(
    summarizeCalls({ llmClient: aborting, model: { id: 'm' }, calls, signal: controller.signal }),
    /aborted/
  );

  const empty = { complete: async () => ({ content: 'Sorry, I cannot help.' }) };
  const nothing = await summarizeCalls({ llmClient: empty, model: { id: 'm' }, calls });
  assert.equal(summaryFailureOf(nothing, calls), 'summary_empty');
});

test('chunks: calls are packed to the size the summary model takes', () => {
  const calls = Array.from({ length: 5 }, (_, i) => ({
    ref: `r${i + 1}`,
    args: '{}',
    content: 'x'.repeat(10_000)
  }));
  const chunks = chunkCalls(calls, 25_000);
  assert.deepEqual(
    chunks.map(c => c.length),
    [2, 2, 1]
  );
});

test('the digest goes into the last condensed result; the calls stay, every other result becomes a stub', () => {
  const messages = transcript();
  const { batches } = selectBatches(messages, { tokensBefore: 1e9, targetTokens: 0 });
  const calls = collectCalls(messages, batches, { nextRef: 1 });
  const digest = renderDigest({
    number: 1,
    calls,
    facts: [{ ref: 'r1', text: 'NVIDIA 5.1T', source: 'https://x.test/nvidia' }],
    notFound: [{ ref: 'r2', text: 'Apple P/E' }]
  });
  const next = applyDigest(messages, calls, digest, 1);
  assert.equal(next.length, messages.length, 'no message added or removed');
  for (const i of [0, 1, 2, 4, 7, 8, 9, 10, 11])
    assert.equal(next[i], messages[i], `message ${i} untouched`);
  assert.ok(
    next
      .slice(3, 7)
      .filter(m => m.role === 'tool')
      .every(m => isCondensedContent(m.content))
  );
  assert.match(
    next[3].content,
    /^\[condensed result r1 of webSearch.*recall_tool_result \{"ref":"r1"\}/
  );
  assert.ok(!next[3].content.includes('<condensed_results'));
  assert.match(next[6].content, /<condensed_results digest="1" refs="r1-r3">/);
  assert.match(next[6].content, /- r1 · webSearch · \{"query":"c1"\} · ok/);
  assert.match(next[6].content, /nvidia — https:\/\/x\.test\/nvidia/);
  assert.match(next[6].content, /- \[r1\] NVIDIA 5\.1T \(https:\/\/x\.test\/nvidia\)/);
  assert.match(next[6].content, /Looked for, not found:\n- \[r2\] Apple P\/E/);
  assert.match(next[6].content, /Do not run these calls again/);
  assert.equal(next[6].tool_call_id, 'c3', 'the tool message keeps its call id');
  assert.deepEqual(condensedStateOf(next), { nextRef: 4, digests: 1 });
});

test('a lossy digest says so; facts over the size are counted, not cut mid-line', () => {
  const calls = [{ ref: 'r1', name: 'webSearch', args: '{}', failed: true, sources: [] }];
  const lossy = renderDigest({ number: 2, calls, fallbackReason: 'summary_failed' });
  assert.match(lossy, /lossy="true"/);
  assert.match(lossy, /Facts could not be extracted/);
  assert.match(lossy, /· failed/);
  const many = renderDigest({
    number: 1,
    calls,
    facts: Array.from({ length: 200 }, (_, i) => ({
      ref: 'r1',
      text: `fact ${i} ${'z'.repeat(80)}`
    })),
    maxChars: 3000
  });
  assert.ok(many.length <= 3200);
  assert.match(many, /more facts; read the results with recall_tool_result/);
});

test('kinds are counted from the server-side classification', () => {
  const calls = [{ toolDef: { k: 'search' } }, { toolDef: { k: 'fetch' } }, { toolDef: null }];
  assert.deepEqual(
    kindsOf(calls, def => def?.k),
    { search: 1, fetch: 1, tool: 1 }
  );
});

test('recall: the tool is loop-internal; a long result comes in pages', () => {
  const def = recallToolDefinition('de');
  assert.equal(def.id, RECALL_TOOL_ID);
  assert.equal(def.isInternalTool, true);
  assert.equal(def.isCompactionRecall, true);
  assert.equal(def.name, 'Früheres Ergebnis erneut lesen');
  const entry = { ref: 'r1', name: 'webSearch', args: '{}', content: 'a'.repeat(25_000) };
  const first = recallPage(entry);
  assert.match(first, /Characters 0–20000 of 25000\. Read on with offset 20000\./);
  const second = recallPage(entry, 20_000);
  assert.match(second, /Characters 20000–25000 of 25000\.\n/);
});

test('the task is the last message a person wrote, not a nudge or a steer', () => {
  assert.equal(
    taskOf([
      { role: 'user', content: 'the question' },
      { role: 'user', content: 'go on', _nudge: true },
      { role: 'user', content: '[steer] x', _steer: true }
    ]),
    'the question'
  );
});

test('instructions and short results stay verbatim; the rest of their batch is condensed', () => {
  const messages = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [call('s1', 'activate_skill', { name: 'x' }), call('c1'), call('c2')]
    },
    {
      role: 'tool',
      tool_call_id: 's1',
      name: 'activate_skill',
      content: 'skill body '.repeat(500)
    },
    { role: 'tool', tool_call_id: 'c1', name: 'webSearch', content: big('a') },
    { role: 'tool', tool_call_id: 'c2', name: 'webSearch', content: '{"results":[]}' },
    { role: 'assistant', content: '', tool_calls: [call('c3')] },
    { role: 'tool', tool_call_id: 'c3', name: 'webSearch', content: big('b') }
  ];
  const toolOf = name =>
    name === 'activate_skill' ? { id: 'activate_skill', isInternalTool: true } : { id: name };
  assert.equal(keepsVerbatim({ id: 'ask_user' }, 'ask_user'), true);
  assert.equal(keepsVerbatim(recallToolDefinition(), RECALL_TOOL_ID), false);
  const { batches } = selectBatches(messages, {
    tokensBefore: 1e9,
    targetTokens: 0,
    keepRecentBatches: 1,
    toolOf
  });
  const calls = collectCalls(messages, batches, { nextRef: 1, toolOf });
  assert.deepEqual(
    calls.map(c => c.callId),
    ['c1'],
    'the skill body and the short result stay'
  );
  assert.ok(MIN_CONDENSE_CHARS > '{"results":[]}'.length);
});
