// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One test per normalisation rule of the golden harness (`normalise.js`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  applyDateRule,
  assertIncreasing,
  canonicalJson,
  createNormaliser,
  mergeStepDeltas,
  normaliseEnvelopes,
  normaliseLedger,
  orderParallelGroups,
  projectModelRequest,
  sha256
} from './normalise.js';

const UUID_A = '0b0c7d3e-5a1f-4c7e-9d2b-3f4a5b6c7d8e';
const UUID_B = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';

test('ids are numbered by first appearance, so the same id in two places stays the same id', () => {
  const { normalise, ids } = createNormaliser();
  const out = normalise({
    events: [
      { runId: `chat-${UUID_A}`, parent: null },
      { runId: `subagent-${UUID_B}`, parent: `chat-${UUID_A}` },
      { runId: `chat-${UUID_A.toUpperCase()}`, note: `started by chat-${UUID_A}` }
    ]
  });
  assert.deepEqual(out.events, [
    { parent: null, runId: 'chat-<id:1>' },
    { parent: 'chat-<id:1>', runId: 'subagent-<id:2>' },
    { note: 'started by chat-<id:1>', runId: 'chat-<id:1>' }
  ]);
  assert.equal(ids.size, 2);
});

test('ids: ULIDs, segment ids and the suffix of a synthetic chat id are ids too; other text is not', () => {
  const { normalise } = createNormaliser();
  assert.deepEqual(
    normalise({
      outputId: '01M7W3NP4V8ARWS4E9VM3E5QDZ',
      segment: 'seg-4fc1c010',
      chatId: `agent:chat-${UUID_A}:1a2b3c4d`,
      callId: 'call_1',
      word: 'ABCDEFGHJKMNPQRSTVWXYZ0123',
      hash: 'c7b4ec9ea629f13cce275035fa6bec84bf27599dabfc6df21a9889571c814135'
    }),
    {
      callId: 'call_1',
      // The run id inside is numbered first, then the random suffix.
      chatId: 'agent:chat-<id:1>:<id:2>',
      hash: 'c7b4ec9ea629f13cce275035fa6bec84bf27599dabfc6df21a9889571c814135',
      outputId: '<id:3>',
      segment: 'seg-<id:4>',
      // 26 characters of the ULID alphabet, but a ULID starts with 0 to 7.
      word: 'ABCDEFGHJKMNPQRSTVWXYZ0123'
    }
  );
});

test('ids: the numbering does not depend on the order a producer filled an object in', () => {
  const a = createNormaliser().normalise({ first: UUID_A, second: UUID_B });
  const b = createNormaliser().normalise({ second: UUID_B, first: UUID_A });
  assert.deepEqual(a, { first: '<id:1>', second: '<id:2>' });
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test('ids: a surface can add its own pattern', () => {
  const { normalise } = createNormaliser({ idPatterns: [/\bmsg-(\d+-\d+)\b/g] });
  assert.deepEqual(normalise(['msg-1829751529207-593', 'msg-1829751529207-593', 'msg-1-2']), [
    'msg-<id:1>',
    'msg-<id:1>',
    'msg-<id:2>'
  ]);
});

test('timestamps: ISO strings anywhere in a text, dates, and epoch milliseconds under a time key', () => {
  const { normalise } = createNormaliser();
  assert.deepEqual(
    normalise({
      ts: '2026-11-20T09:12:48.479Z',
      created_at: '2026-11-20T09:12:48Z',
      startedAt: 1795165968479,
      finishedAt: new Date(0),
      text: 'the local time is 2026-11-20T09:12:48+00:00 (timezone UTC)',
      // An example in a tool description has no seconds and is left alone.
      example: 'once: local date and time, e.g. 2026-10-01T09:00',
      // A small number under a time key is a count or an offset, not a point in time.
      retryAt: 3,
      count: 1795165968479
    }),
    {
      count: 1795165968479,
      created_at: '<ts>',
      example: 'once: local date and time, e.g. 2026-10-01T09:00',
      finishedAt: '<ts>',
      retryAt: 3,
      startedAt: '<ts>',
      text: 'the local time is <ts> (timezone UTC)',
      ts: '<ts>'
    }
  );
});

test('durations become <ms>; a limit in milliseconds is a setting and stays', () => {
  const { normalise } = createNormaliser();
  assert.deepEqual(
    normalise({
      durationMs: 9,
      latencyMs: 120,
      lat: 16,
      ttft: 15,
      took: 3,
      timeoutMs: 120000,
      maxWallClockMs: 180000,
      nested: [{ durationMs: 0 }]
    }),
    {
      durationMs: '<ms>',
      lat: '<ms>',
      latencyMs: '<ms>',
      maxWallClockMs: 180000,
      nested: [{ durationMs: '<ms>' }],
      timeoutMs: 120000,
      took: '<ms>',
      ttft: '<ms>'
    }
  );
});

test('the date sentence of the system prompt is replaced, in English and in German', () => {
  assert.equal(
    applyDateRule('The current date is Friday, November 20, 2026. Any dates before this are past.'),
    'The current date is <date>. Any dates before this are past.'
  );
  assert.equal(
    applyDateRule('Very important: The current date is Freitag, 20. November 2026. You write.'),
    'Very important: The current date is <date>. You write.'
  );
  assert.equal(applyDateRule('You write digests.'), 'You write digests.');
  // Applied to every text, so the request header in the ledger gets it as well.
  const { normalise } = createNormaliser();
  assert.deepEqual(
    normalise({
      messages: [{ role: 'system', content: 'The current date is Saturday, 1 January 2028.' }]
    }),
    { messages: [{ content: 'The current date is <date>.', role: 'system' }] }
  );
});

test('temporary paths, hashes over dated content and the product version are replaced', () => {
  const tmp = path.join(os.tmpdir(), 'ihub-golden-AbC123', 'data', 'runs');
  const { normalise } = createNormaliser({ appVersion: '5.7.2' });
  assert.deepEqual(
    normalise({
      path: tmp,
      message: `could not read ${tmp}/x.json`,
      requestHash: 'b1edb5da380e8eff21b3b2177839294f94ab62388aa4c94b8adb1f5d85eaf657',
      messagesHash: 'f497b5da0ef62e0a467f79c80780462a3ba682d829388449fdeef6a412d7600e',
      toolSchemasHash: 'a0fe639de4a5a57b6b72980ca0ffd559f41a80ae2fe723298c8b86cb23aea807',
      generator: { version: '5.7.2' },
      text: 'needs iHub 5.7.2 or later'
    }),
    {
      generator: { version: '<version>' },
      message: `could not read <tmp>${path.sep}data${path.sep}runs/x.json`,
      messagesHash: '<hash>',
      path: `<tmp>${path.sep}data${path.sep}runs`,
      requestHash: '<hash>',
      // Only a value that is the version; a sentence that names it is content.
      text: 'needs iHub 5.7.2 or later',
      // The tool definitions hold no date: this hash is stable and stays.
      toolSchemasHash: 'a0fe639de4a5a57b6b72980ca0ffd559f41a80ae2fe723298c8b86cb23aea807'
    }
  );
});

test('a surface can name more volatile keys', () => {
  const { normalise } = createNormaliser({ volatileKeys: ['etag', 'port'] });
  assert.deepEqual(
    normalise({ etag: 'W/"abc"', port: 51234, kept: 1, nested: { etag: { a: 1 } } }),
    {
      etag: '<volatile>',
      kept: 1,
      nested: { etag: '<volatile>' },
      port: '<volatile>'
    }
  );
});

test('seq and rseq are dropped, after a check that they increase', () => {
  const normaliser = createNormaliser();
  const envelopes = [
    {
      v: 2,
      seq: 4,
      rseq: 1,
      runId: 'chat-1',
      ts: '2026-11-20T09:12:48.479Z',
      type: 'run/started',
      data: { kind: 'chat' }
    },
    {
      v: 2,
      seq: 5,
      rseq: 2,
      runId: 'chat-1',
      ts: '2026-11-20T09:12:48.480Z',
      type: 'run/ended',
      data: { status: 'completed' }
    }
  ];
  assert.deepEqual(normaliseEnvelopes(envelopes, normaliser), [
    { data: { kind: 'chat' }, runId: 'chat-1', type: 'run/started' },
    { data: { status: 'completed' }, runId: 'chat-1', type: 'run/ended' }
  ]);

  const repeated = [envelopes[0], { ...envelopes[1], seq: 4 }];
  assert.throws(() => normaliseEnvelopes(repeated, normaliser), /seq does not increase at event 1/);
  const backwards = [envelopes[0], { ...envelopes[1], rseq: 1 }];
  assert.throws(() => normaliseEnvelopes(backwards, normaliser), /rseq does not increase/);

  // rseq counts per run: a second run on the same stream starts again at 1.
  assertIncreasing(
    [
      { type: 'a', runId: 'r1', rseq: 1 },
      { type: 'b', runId: 'r2', rseq: 1 },
      { type: 'c', runId: 'r1', rseq: 2 }
    ],
    'rseq',
    event => event.runId
  );

  const ledger = [
    { seq: 1, ts: 'x', runId: 'chat-1', type: 'run/start', data: { kind: 'chat' } },
    { seq: 2, ts: 'x', runId: 'chat-1', type: 'run/end', data: {} }
  ];
  assert.deepEqual(normaliseLedger(ledger, normaliser), [
    { data: { kind: 'chat' }, runId: 'chat-1', type: 'run/start' },
    { data: {}, runId: 'chat-1', type: 'run/end' }
  ]);
  assert.throws(
    () => normaliseLedger([ledger[1], ledger[0]], normaliser),
    /seq does not increase at event 1 \(run\/start\): 2 then 1/
  );
});

test('consecutive step/delta events of one step and kind are merged into one', () => {
  const delta = (content, extra = {}) => ({
    type: 'step/delta',
    runId: 'chat-1',
    data: { step: 1, kind: 'text', content, ...extra }
  });
  const other = { type: 'tool/started', runId: 'chat-1', data: { step: 1, callId: 'c1' } };
  const merged = mergeStepDeltas([
    delta('The '),
    delta('ans'),
    delta('wer.'),
    delta('hm', { kind: 'thinking' }),
    delta('m', { kind: 'thinking' }),
    other,
    delta('Next'),
    delta(' step', { step: 2 }),
    { ...delta('other run'), runId: 'chat-2' },
    delta('image', { kind: 'image', meta: { mimeType: 'image/png' } }),
    delta('image', { kind: 'image', meta: { mimeType: 'image/png' } })
  ]);
  assert.deepEqual(
    merged.map(e => [e.type, e.runId, e.data.step, e.data.kind, e.data.content]),
    [
      ['step/delta', 'chat-1', 1, 'text', 'The answer.'],
      ['step/delta', 'chat-1', 1, 'thinking', 'hmm'],
      ['tool/started', 'chat-1', 1, undefined, undefined],
      ['step/delta', 'chat-1', 1, 'text', 'Next'],
      ['step/delta', 'chat-1', 2, 'text', ' step'],
      ['step/delta', 'chat-2', 1, 'text', 'other run'],
      // A delta with metadata is a thing of its own and is never merged.
      ['step/delta', 'chat-1', 1, 'image', 'image'],
      ['step/delta', 'chat-1', 1, 'image', 'image']
    ]
  );
  // However the text was cut, the record is the same.
  const once = normaliseEnvelopes([delta('The answer.')], createNormaliser());
  const cut = normaliseEnvelopes(
    ['T', 'he an', 'swer', '.'].map(c => delta(c)),
    createNormaliser()
  );
  assert.deepEqual(cut, once);
});

test('events of one parallelGroup are ordered by call id, whatever order the tools finished in', () => {
  const event = (type, callId, parallelGroup, extra = {}) => ({
    type,
    runId: 'chat-1',
    data: { step: 1, callId, ...(parallelGroup === undefined ? {} : { parallelGroup }), ...extra }
  });
  const before = { type: 'message/assistant', runId: 'chat-1', data: { step: 1 } };
  const after = { type: 'budget/checkpoint', runId: 'chat-1', data: { step: 1 } };
  const expected = [
    before,
    event('tool/call', 'call_1', 0),
    event('tool/result', 'call_1', 0),
    event('tool/call', 'call_2', 0),
    event('tool/result', 'call_2', 0),
    event('tool/call', 'call_3', 1),
    after
  ];
  // The same events as the tools happened to finish: call_2 first.
  const arrived = [
    before,
    event('tool/call', 'call_2', 0),
    event('tool/call', 'call_1', 0),
    event('tool/result', 'call_2', 0),
    event('tool/result', 'call_1', 0),
    event('tool/call', 'call_3', 1),
    after
  ];
  assert.deepEqual(orderParallelGroups(arrived), expected);
  assert.deepEqual(orderParallelGroups(expected), expected);

  // Events without a group keep their place and end a group.
  const split = [
    event('tool/call', 'call_9', 0),
    event('tool/result', 'call_9', undefined),
    event('tool/call', 'call_1', 0)
  ];
  assert.deepEqual(orderParallelGroups(split), split);
  // Another step or another run is another group, even with the same number.
  const steps = [event('tool/call', 'call_9', 0), event('tool/call', 'call_1', 0, { step: 2 })];
  assert.deepEqual(orderParallelGroups(steps), steps);
});

test('heartbeat and stream/connected frames are dropped', () => {
  const kept = normaliseEnvelopes(
    [
      { seq: 1, type: 'stream/connected', data: {} },
      { seq: 2, type: 'run/started', runId: 'chat-1', data: {} },
      { seq: 3, type: 'heartbeat', data: {} },
      { seq: 4, type: 'run/ended', runId: 'chat-1', data: {} }
    ],
    createNormaliser()
  );
  assert.deepEqual(
    kept.map(e => e.type),
    ['run/started', 'run/ended']
  );
});

const openAiRequest = (overrides = {}) => ({
  url: 'https://model.invalid/v1/chat/completions',
  headers: { Authorization: 'Bearer sk-golden' },
  body: {
    model: 'gpt-golden',
    stream: true,
    max_tokens: 16384,
    messages: [
      { role: 'system', content: 'The current date is Friday, November 20, 2026.\n\nYou answer.' },
      { role: 'user', content: 'Look it up' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{}' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a record',
          parameters: { type: 'object', properties: { key: { type: 'string' } } }
        }
      }
    ],
    ...overrides
  }
});

test('the model request projection: roles, system prompt hash, tools with schema, options', () => {
  const { projection, schemas } = projectModelRequest(openAiRequest(), createNormaliser());
  assert.deepEqual(projection.roles, ['system', 'user', 'assistant', 'tool']);
  assert.equal(
    projection.systemPromptHash,
    sha256('The current date is <date>.\n\nYou answer.'),
    'the hash is taken after the date rule'
  );
  assert.deepEqual(projection.options, { max_tokens: 16384, model: 'gpt-golden', stream: true });
  assert.equal(projection.tools.length, 1);
  assert.equal(projection.tools[0].name, 'lookup');
  assert.deepEqual(schemas[projection.tools[0].schema], {
    properties: { key: { type: 'string' } },
    type: 'object'
  });
  // Neither the key nor the URL of the provider is part of a record.
  assert.doesNotMatch(JSON.stringify(projection), /sk-golden|model\.invalid/);
});

test('the projection is the same on another day, and differs when the prompt, a schema or an option changes', () => {
  const project = request => projectModelRequest(request, createNormaliser()).projection;
  const base = project(openAiRequest());

  const nextDay = openAiRequest();
  nextDay.body.messages[0].content =
    'The current date is Samstag, 21. November 2026.\n\nYou answer.';
  assert.deepEqual(project(nextDay), base);

  const reordered = openAiRequest();
  reordered.body.messages[0].content =
    'You answer.\n\nThe current date is Friday, November 20, 2026.';
  assert.notEqual(project(reordered).systemPromptHash, base.systemPromptHash);

  const roleOrder = openAiRequest();
  roleOrder.body.messages.reverse();
  assert.notDeepEqual(project(roleOrder).roles, base.roles);

  const schema = openAiRequest();
  schema.body.tools[0].function.parameters.properties.key.description = 'The key';
  assert.notEqual(project(schema).tools[0].schema, base.tools[0].schema);

  const renamed = openAiRequest();
  renamed.body.tools[0].function.name = 'find';
  assert.notDeepEqual(project(renamed).tools, base.tools);

  assert.notDeepEqual(project(openAiRequest({ temperature: 0.2 })).options, base.options);
});

test('the projection reads the request shapes of the other adapters', () => {
  const project = body => projectModelRequest({ body }, createNormaliser());
  const parameters = { type: 'object', properties: {} };

  const anthropic = project({
    model: 'claude',
    max_tokens: 1024,
    system: [{ type: 'text', text: 'You answer.' }],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'lookup', description: 'x', input_schema: parameters }]
  });
  assert.deepEqual(anthropic.projection.roles, ['user']);
  assert.equal(anthropic.projection.systemPromptHash, sha256('You answer.'));
  assert.deepEqual(anthropic.projection.options, { max_tokens: 1024, model: 'claude' });
  assert.equal(anthropic.projection.tools[0].name, 'lookup');

  const google = project({
    systemInstruction: { parts: [{ text: 'You answer.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'yo' }] }
    ],
    tools: [
      {
        functionDeclarations: [
          { name: 'lookup', parameters },
          { name: 'find', parameters }
        ]
      }
    ],
    generationConfig: { maxOutputTokens: 100 }
  });
  assert.deepEqual(google.projection.roles, ['user', 'model']);
  assert.equal(google.projection.systemPromptHash, sha256('You answer.'));
  assert.deepEqual(
    google.projection.tools.map(t => t.name),
    ['lookup', 'find']
  );
  assert.deepEqual(google.projection.options, { generationConfig: { maxOutputTokens: 100 } });

  const responses = project(
    JSON.stringify({
      model: 'gpt-5',
      instructions: 'You answer.',
      input: [
        { role: 'user', content: 'hi' },
        { type: 'function_call_output', output: '{}' }
      ],
      tools: [{ type: 'function', name: 'lookup', parameters }, { type: 'web_search' }]
    })
  );
  assert.deepEqual(responses.projection.roles, ['user', 'function_call_output']);
  assert.equal(responses.projection.systemPromptHash, sha256('You answer.'));
  assert.deepEqual(responses.projection.tools, [
    { name: 'lookup', schema: responses.projection.tools[0].schema },
    { name: 'web_search', schema: null }
  ]);

  assert.equal(
    project({ messages: [{ role: 'user', content: 'hi' }] }).projection.systemPromptHash,
    null
  );
});

test('canonicalJson sorts keys, drops undefined and ends with a newline', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } }),
    '{\n  "a": {\n    "c": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n'
  );
});
