// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A chat turn runs the read-only tool calls of one model step side by side
 * when the feature `parallelToolCalls` is on (#2485), and one at a time in
 * every other case.
 *
 * The runs are real: a chat turn through `ChatService` and the product's
 * `AgentLoop`, on a scripted model. Whether calls overlap is decided by a
 * latch, never by a timer: a tool of the parallel cases returns only after
 * every call of its batch has started, which a serial run can never satisfy
 * (the test would stop at its timeout instead of passing by luck). The serial
 * cases count how many calls are in flight at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startGoldenEnv } from './harness.js';
import { harnessConfig, runChatTurn } from './harnessCases.js';
import { observeEmittedEnvelopes, projectLedgerEvent } from '../../services/loop/RunStream.js';
import { chatToolPolicies } from '../../services/chat/chatTurnPolicies.js';
import { RunService, appRunSpec } from '../../services/run/RunService.js';
import { HeadlessHost } from '../../services/run/hosts/HeadlessHost.js';
import { requestRunContext } from '../../services/run/principalResolver.js';
import { knownModelKeys, modelConfigSchema } from '../../validators/modelConfigSchema.js';
import { abortChatRequest } from '../../sse.js';
import { throttledRun } from '../../requestThrottler.js';
import { rebuildRunActivity } from '../../services/chat/runActivity.js';
import { buildRunActivity } from '../../../shared/run/runActivity.js';
import { createStreamState, reduceRunEvents } from '../../../shared/run/runReducer.js';
import { fixtureInstallation, fixtureTool } from '../helpers/integrationToolFixture.js';
import { scriptedModel, turn } from '../helpers/scriptedModel.js';
import { byCodeUnit } from './byCodeUnit.js';

const CHAT_ID = '0c0ffee0-0000-4000-8000-0000000ead01';

/** A failed latch must end the test, not the suite's patience. */
const LATCH_TIMEOUT = { timeout: 30_000 };

const USAGE = [
  { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 }
];

/** A promise with its resolver. */
function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * What the tools of a case report about themselves: the order they started and
 * ended in, and how many ran at the same time.
 */
function createProbe() {
  const probe = {
    started: [],
    ended: [],
    inFlight: 0,
    maxInFlight: 0,
    waiters: [],
    enter(key) {
      probe.started.push(key);
      probe.inFlight += 1;
      probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
      for (const waiter of probe.waiters.filter(w => w.count <= probe.started.length)) {
        waiter.resolve();
      }
    },
    leave(key) {
      probe.inFlight -= 1;
      probe.ended.push(key);
    },
    /** Resolves once `count` calls have started. */
    whenStarted(count) {
      if (probe.started.length >= count) return Promise.resolve();
      const waiter = { count, ...deferred() };
      probe.waiters.push(waiter);
      return waiter.promise;
    }
  };
  return probe;
}

const parameters = {
  type: 'object',
  properties: { key: { type: 'string', description: 'The key of the record' } },
  required: ['key']
};

/**
 * The configuration of a case: the harness's desk app with a read (`lookup`)
 * and a write (`store`), both reporting to the probe.
 *
 * @param {Object} options
 * @param {ReturnType<typeof createProbe>} options.probe
 * @param {(key: string) => Promise<void>} [options.hold] - What a call waits for before it returns.
 * @param {Object} [options.features]
 * @param {Object} [options.model] - Fields laid over the model of the harness.
 */
function caseConfig({ probe, hold = async () => {}, features = {}, model = {} }) {
  const config = harnessConfig();
  const run = async args => {
    probe.enter(args.key);
    try {
      await hold(args.key);
      if (args.key === 'FAIL') throw new Error('the record store is down');
      return { key: args.key, value: `record ${args.key}` };
    } finally {
      probe.leave(args.key);
    }
  };
  config.features = { ...config.features, ...features };
  config.models = config.models.map(entry => ({ ...entry, ...model }));
  config.apps = config.apps.map(app => ({ ...app, integrations: { lookup: {}, store: {} } }));
  config.groups.groups.users.permissions.integrations = ['lookup', 'store'];
  config.tools = [
    fixtureTool('lookup', { description: 'Look up a record', parameters, run }),
    fixtureTool('store', {
      description: 'Store a record',
      sideEffect: 'write',
      parameters,
      run
    })
  ];
  config.integrations = () => ({
    installed: [fixtureInstallation('lookup'), fixtureInstallation('store')],
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
  return config;
}

/**
 * Run one chat turn of a case and return what it produced, as it arrived.
 *
 * @param {Object} config - From {@link caseConfig}.
 * @param {Object[]} script - The turns of the scripted model.
 * @param {Object} [options]
 * @param {string} [options.chatId]
 * @param {(env: Object) => (void|Promise<void>)} [options.during] - Started with the turn.
 */
async function runCase(config, script, { chatId = CHAT_ID, during } = {}) {
  const env = await startGoldenEnv(config);
  try {
    env.model = scriptedModel(script);
    const running = runChatTurn(env, { chatId, message: 'Look up the records.' });
    const [parts] = await Promise.all([running, during ? during(env) : null]);
    await env.settle();
    const ledger = [...env.ledger];
    const runId = ledger.find(event => event.type === 'tool/call')?.runId;
    return {
      result: parts.result,
      runId,
      ledger,
      envelopes: env.envelopes.map(delivery => delivery.envelope),
      requests: env.model.requests,
      // The activity of the run read back from its ledger: what a reload shows
      // for a turn whose live frames nobody kept.
      rebuiltActivity: runId ? await rebuildRunActivity(env.runLog, runId) : null
    };
  } finally {
    await env.stop();
  }
}

const calls = (...specs) =>
  turn.toolCalls(
    specs.map(([name, key]) => ({ name, args: { key } })),
    { usage: USAGE[0] }
  );
const answer = () => turn.text(['The records ', 'are open.'], { usage: USAGE[1] });

const toolFrames = envelopes =>
  envelopes
    .filter(envelope => envelope.type === 'tool/started' || envelope.type === 'tool/completed')
    .map(envelope => `${envelope.type} ${envelope.data.callId}`);
const started = envelopes => envelopes.filter(envelope => envelope.type === 'tool/started');
/** The body of a request as it went to the provider. */
const bodyOf = request =>
  typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
/** The tool results a model request carries, in the order they stand in it. */
const toolResults = request =>
  bodyOf(request)
    .messages.filter(message => message.role === 'tool')
    .map(message => [message.tool_call_id, JSON.parse(message.content)]);

const FLAG_ON = { parallelToolCalls: true };

/**
 * The ledger of a run with its `tool/call` events in the reverse order. Every
 * place in the ledger keeps its `seq` and `ts`, as if the calls had been
 * recorded in that order.
 *
 * @param {Object[]} events - The ledger events of one run, in order.
 * @returns {Object[]}
 */
function withToolCallsReversed(events) {
  const reversed = events.filter(event => event.type === 'tool/call').reverse();
  return events.map(event => {
    if (event.type !== 'tool/call') return event;
    const { seq, ts } = event;
    return { ...reversed.shift(), seq, ts };
  });
}

test(
  'flag on: three read-only calls run in one batch, and the model gets them in call order',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    // The calls finish in the reverse of the order the model asked for them in.
    const completed = { call_2: deferred(), call_3: deferred() };
    const waitsFor = { 'A-1': completed.call_2.promise, 'B-2': completed.call_3.promise };
    const unobserve = observeEmittedEnvelopes(envelope => {
      if (envelope.type === 'tool/completed') completed[envelope.data?.callId]?.resolve();
    });
    let run;
    try {
      run = await runCase(
        caseConfig({
          probe,
          features: FLAG_ON,
          hold: async key => {
            // The latch: nobody returns before all three have started.
            await probe.whenStarted(3);
            await waitsFor[key];
          }
        }),
        [calls(['lookup', 'A-1'], ['lookup', 'B-2'], ['lookup', 'C-3']), answer()]
      );
    } finally {
      unobserve();
    }

    assert.equal(probe.maxInFlight, 3, 'the three calls were in flight at once');
    assert.deepEqual(probe.ended, ['C-3', 'B-2', 'A-1']);
    assert.deepEqual(toolFrames(run.envelopes), [
      'tool/started call_1',
      'tool/started call_2',
      'tool/started call_3',
      'tool/completed call_3',
      'tool/completed call_2',
      'tool/completed call_1'
    ]);

    // What the model is sent next: the results in the order of its calls.
    assert.equal(run.requests.length, 2);
    assert.deepEqual(toolResults(run.requests[1]), [
      ['call_1', { key: 'A-1', value: 'record A-1' }],
      ['call_2', { key: 'B-2', value: 'record B-2' }],
      ['call_3', { key: 'C-3', value: 'record C-3' }]
    ]);
    assert.equal(run.result.status, 'completed');
    assert.equal(run.result.content, 'The records are open.');

    // The server says which calls share a batch and where each stands in it.
    assert.deepEqual(
      started(run.envelopes).map(envelope => [
        envelope.data.callId,
        envelope.data.parallelGroup,
        envelope.data.callIndex
      ]),
      [
        ['call_1', 0, 0],
        ['call_2', 0, 1],
        ['call_3', 0, 2]
      ]
    );
    assert.deepEqual(
      run.ledger
        .filter(event => event.type === 'tool/call')
        .map(event => [event.data.callId, event.data.parallelGroup, event.data.callIndex]),
      [
        ['call_1', 0, 0],
        ['call_2', 0, 1],
        ['call_3', 0, 2]
      ]
    );

    // The rows: in call order live, whatever order the frames of a batch arrive in ...
    const { runId } = run;
    const frames = run.envelopes.filter(envelope => envelope.runId === runId);
    // The second arrangement: the three `tool/started` frames in reverse.
    const firstStarted = frames.findIndex(envelope => envelope.type === 'tool/started');
    const scrambled = [
      ...frames.slice(0, firstStarted),
      ...started(frames).reverse(),
      ...frames.slice(firstStarted).filter(envelope => envelope.type !== 'tool/started')
    ];
    for (const order of [frames, scrambled]) {
      const state = reduceRunEvents(createStreamState(runId), order);
      assert.deepEqual(
        state.runs[runId].tools.map(tool => tool.callId),
        ['call_1', 'call_2', 'call_3']
      );
      // ... in the activity stored with the answer, which is built from that state ...
      assert.deepEqual(
        buildRunActivity(state.runs[runId]).toolActivity.items.map(item => item.id),
        ['call_1', 'call_2', 'call_3']
      );
    }
    // ... and in the activity read back from the ledger of the run.
    assert.deepEqual(
      run.rebuiltActivity.toolActivity.items.map(item => item.id),
      ['call_1', 'call_2', 'call_3']
    );

    // What a reload, a replay of the stream and the recovery of a chat read is the
    // ledger, through `projectLedgerEvent`. Its frames carry the batch and the place
    // as the ledger holds them ...
    const ofRun = run.ledger.filter(event => event.runId === runId);
    assert.deepEqual(
      ofRun
        .filter(event => event.type === 'tool/call')
        .flatMap(event => projectLedgerEvent(event))
        .map(frame => [
          frame.type,
          frame.data.callId,
          frame.data.parallelGroup,
          frame.data.callIndex
        ]),
      [
        ['tool/started', 'call_1', 0, 0],
        ['tool/started', 'call_2', 0, 1],
        ['tool/started', 'call_3', 0, 2]
      ]
    );
    // ... and the calls of a batch can reach the ledger in any order: each passes
    // its pre-tool seams on its own, and a slower one is recorded later. The same
    // ledger with the three calls recorded in reverse still gives the call order.
    const rebuiltIds = async events =>
      (await rebuildRunActivity({ readEvents: async () => events }, runId)).toolActivity.items.map(
        item => item.id
      );
    const recordedInReverse = withToolCallsReversed(ofRun);
    assert.deepEqual(
      recordedInReverse.filter(event => event.type === 'tool/call').map(event => event.data.callId),
      ['call_3', 'call_2', 'call_1']
    );
    assert.deepEqual(await rebuiltIds(recordedInReverse), ['call_1', 'call_2', 'call_3']);
    // The order comes from the place the server recorded and from nothing else: the
    // same ledger without it lists the calls as they were recorded.
    const withoutPlace = recordedInReverse.map(event => {
      if (event.type !== 'tool/call') return event;
      const { callIndex: _place, ...data } = event.data;
      return { ...event, data };
    });
    assert.deepEqual(await rebuiltIds(withoutPlace), ['call_3', 'call_2', 'call_1']);
  }
);

test(
  'flag off: the same calls run one at a time, and no frame names a batch',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    const run = await runCase(caseConfig({ probe }), [
      calls(['lookup', 'A-1'], ['lookup', 'B-2'], ['lookup', 'C-3']),
      answer()
    ]);
    assert.equal(probe.maxInFlight, 1);
    assert.deepEqual(probe.started, ['A-1', 'B-2', 'C-3']);
    assert.deepEqual(toolFrames(run.envelopes), [
      'tool/started call_1',
      'tool/completed call_1',
      'tool/started call_2',
      'tool/completed call_2',
      'tool/started call_3',
      'tool/completed call_3'
    ]);
    for (const envelope of started(run.envelopes)) {
      assert.equal('parallelGroup' in envelope.data, false);
      assert.equal('callIndex' in envelope.data, false);
    }
    for (const event of run.ledger.filter(entry => entry.type === 'tool/call')) {
      assert.equal('callIndex' in event.data, false);
    }
    assert.deepEqual(
      toolResults(run.requests[1]).map(([id]) => id),
      ['call_1', 'call_2', 'call_3']
    );
  }
);

test(
  'flag on and off give the model the same requests and the same answer',
  LATCH_TIMEOUT,
  async () => {
    const script = () => [calls(['lookup', 'A-1'], ['lookup', 'B-2']), answer()];
    const off = await runCase(caseConfig({ probe: createProbe() }), script());
    const onProbe = createProbe();
    const on = await runCase(
      caseConfig({ probe: onProbe, features: FLAG_ON, hold: () => onProbe.whenStarted(2) }),
      script()
    );
    assert.equal(onProbe.maxInFlight, 2);
    // The bodies, whole: messages, tools and every option.
    assert.equal(off.requests.length, 2);
    assert.deepEqual(
      on.requests.map(request => bodyOf(request)),
      off.requests.map(request => bodyOf(request))
    );
    // One model step is one round and two model calls, however its tools ran.
    const { provenance: _on, ...onResult } = on.result;
    const { provenance: _off, ...offResult } = off.result;
    assert.deepEqual(onResult, offResult);
    assert.deepEqual(on.result.usage, {
      promptTokens: 120,
      completionTokens: 17,
      totalTokens: 137,
      source: 'provider'
    });
  }
);

test('flag on, a model that opts out: the calls run one at a time', LATCH_TIMEOUT, async () => {
  const probe = createProbe();
  const run = await runCase(
    caseConfig({ probe, features: FLAG_ON, model: { parallelToolCalls: false } }),
    [calls(['lookup', 'A-1'], ['lookup', 'B-2']), answer()]
  );
  assert.equal(probe.maxInFlight, 1);
  assert.deepEqual(toolFrames(run.envelopes), [
    'tool/started call_1',
    'tool/completed call_1',
    'tool/started call_2',
    'tool/completed call_2'
  ]);
  assert.equal('callIndex' in started(run.envelopes)[0].data, false);
});

test(
  'flag on, one write in the step: every call runs alone, in the model order',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    const run = await runCase(caseConfig({ probe, features: FLAG_ON }), [
      calls(['lookup', 'A-1'], ['store', 'S-9'], ['lookup', 'B-2']),
      answer()
    ]);
    assert.equal(probe.maxInFlight, 1);
    assert.deepEqual(probe.started, ['A-1', 'S-9', 'B-2']);
    assert.deepEqual(probe.ended, ['A-1', 'S-9', 'B-2']);
    assert.deepEqual(toolFrames(run.envelopes), [
      'tool/started call_1',
      'tool/completed call_1',
      'tool/started call_2',
      'tool/completed call_2',
      'tool/started call_3',
      'tool/completed call_3'
    ]);
  }
);

test(
  'flag on, two writes: never side by side, however different their arguments',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    await runCase(caseConfig({ probe, features: FLAG_ON }), [
      calls(['store', 'S-1'], ['store', 'S-2']),
      answer()
    ]);
    assert.equal(probe.maxInFlight, 1);
    assert.deepEqual(probe.started, ['S-1', 'S-2']);
  }
);

test(
  'flag on, one call of a batch fails: the other one finishes and both results reach the model',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    const run = await runCase(
      caseConfig({ probe, features: FLAG_ON, hold: () => probe.whenStarted(2) }),
      [calls(['lookup', 'FAIL'], ['lookup', 'B-2']), answer()]
    );
    assert.equal(probe.maxInFlight, 2);
    const results = toolResults(run.requests[1]);
    assert.deepEqual(
      results.map(([id]) => id),
      ['call_1', 'call_2']
    );
    assert.equal(results[0][1].error, true);
    assert.match(results[0][1].message, /the record store is down/);
    assert.deepEqual(results[1][1], { key: 'B-2', value: 'record B-2' });
    assert.equal(run.result.status, 'completed');
    // Both rows end: one failed, one done.
    const completedFrames = run.envelopes.filter(envelope => envelope.type === 'tool/completed');
    assert.deepEqual(
      completedFrames
        .map(envelope => [envelope.data.callId, Boolean(envelope.data.error)])
        .sort(([left], [right]) => byCodeUnit(left, right)),
      [
        ['call_1', true],
        ['call_2', false]
      ]
    );
  }
);

test(
  'flag on, the turn is stopped while a batch runs: both calls are cancelled',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    const chatId = '0c0ffee0-0000-4000-8000-0000000ead02';
    const never = deferred();
    let run;
    try {
      run = await runCase(
        caseConfig({ probe, features: FLAG_ON, hold: () => never.promise }),
        // No second turn: the model is not asked again after a stop.
        [calls(['lookup', 'A-1'], ['lookup', 'B-2'])],
        {
          chatId,
          during: async () => {
            await probe.whenStarted(2);
            abortChatRequest(chatId, { kind: 'user_stop' });
          }
        }
      );
    } finally {
      // Let the two tool functions end; the loop stopped waiting for them at the stop.
      never.resolve();
    }
    assert.equal(probe.maxInFlight, 2, 'both calls were running when the turn was stopped');
    assert.equal(run.result.status, 'aborted');
    assert.equal(run.requests.length, 1, 'the model was not called again');
    assert.deepEqual(toolFrames(run.envelopes), ['tool/started call_1', 'tool/started call_2']);
    assert.deepEqual(
      run.ledger.filter(event => event.type === 'tool/result'),
      [],
      'neither call left a result'
    );
  }
);

test(
  'flag on: a tool limited to one request at a time keeps its limit inside a batch',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    // What a search tool does with its provider (`braveSearch`: concurrency 1): the
    // loop starts both calls, and the throttle lets one request through at a time.
    const requests = { inFlight: 0, max: 0, order: [] };
    const config = caseConfig({ probe, features: FLAG_ON });
    const [lookup] = config.tools;
    config.tools[0] = {
      ...lookup,
      run: async args => {
        probe.enter(args.key);
        try {
          return await throttledRun(
            'parallel-read-only-test',
            async () => {
              requests.inFlight += 1;
              requests.max = Math.max(requests.max, requests.inFlight);
              requests.order.push(args.key);
              // The request is held until the loop has started both calls.
              await probe.whenStarted(2);
              requests.inFlight -= 1;
              return { key: args.key, value: `record ${args.key}` };
            },
            { concurrency: 1 }
          );
        } finally {
          probe.leave(args.key);
        }
      }
    };
    const run = await runCase(config, [calls(['lookup', 'A-1'], ['lookup', 'B-2']), answer()]);
    assert.equal(probe.maxInFlight, 2, 'the loop ran both calls side by side');
    assert.equal(requests.max, 1, 'the throttle let one request through at a time');
    assert.deepEqual(requests.order, ['A-1', 'B-2']);
    assert.deepEqual(
      toolResults(run.requests[1]).map(([id]) => id),
      ['call_1', 'call_2']
    );
  }
);

// ── the policy itself ───────────────────────────────────────────────────────

test('the tool policy of a chat: serial unless the feature is on and the model stays in', () => {
  const app = { toolChoice: 'required' };
  const serial = { parallel: false, choice: 'required' };
  // Trusted reads only, never the mode `targets`, and at most four at once.
  const sideBySide = {
    parallel: true,
    parallelMode: 'readOnly',
    maxParallel: 4,
    choice: 'required'
  };

  // Feature off, however the model is set: nothing names a mode or a cap.
  for (const features of [{}, { parallelToolCalls: false }]) {
    for (const model of [undefined, { id: 'm' }, { id: 'm', parallelToolCalls: true }]) {
      assert.deepEqual(chatToolPolicies({ app, model, features }), serial);
    }
  }
  // Feature on: every model that does not opt out.
  for (const model of [undefined, { id: 'm' }, { id: 'm', parallelToolCalls: true }]) {
    assert.deepEqual(chatToolPolicies({ app, model, features: FLAG_ON }), sideBySide);
  }
  // Only `false` is the opt-out.
  assert.deepEqual(
    chatToolPolicies({ app, model: { id: 'm', parallelToolCalls: false }, features: FLAG_ON }),
    serial
  );
  // The app's tool choice is passed on as it is, also when the app sets none.
  assert.deepEqual(chatToolPolicies({ app: {}, model: { id: 'm' }, features: {} }), {
    parallel: false,
    choice: undefined
  });
  assert.equal(chatToolPolicies({ app: null, model: null, features: FLAG_ON }).choice, undefined);
});

test('the opt-out of a model: stored by the model schema as a boolean, and read by the policy', () => {
  const base = {
    id: 'm',
    modelId: 'm',
    name: { en: 'M' },
    description: { en: 'M' },
    url: 'https://model.invalid/v1/chat/completions',
    provider: 'openai',
    contextWindow: 1000,
    maxOutputTokens: 100
  };
  assert.ok(knownModelKeys.includes('parallelToolCalls'), 'the field is one of the model file');

  // Absent, true and false pass, and come out as they went in.
  const absent = modelConfigSchema.parse(base);
  assert.equal('parallelToolCalls' in absent, false);
  const stays = modelConfigSchema.parse({ ...base, parallelToolCalls: true });
  assert.equal(stays.parallelToolCalls, true);
  const optsOut = modelConfigSchema.parse({ ...base, parallelToolCalls: false });
  assert.equal(optsOut.parallelToolCalls, false);

  // Anything that is no boolean is refused, so a form or a file cannot store an
  // opt-out the policy would not read as one.
  for (const value of ['false', 'true', 0, 1, null, {}]) {
    const result = modelConfigSchema.safeParse({ ...base, parallelToolCalls: value });
    assert.equal(result.success, false, JSON.stringify(value));
    assert.deepEqual(result.error.issues[0].path, ['parallelToolCalls']);
  }

  // What the schema stored is what decides.
  const policyOf = model => chatToolPolicies({ app: {}, model, features: FLAG_ON }).parallel;
  assert.equal(policyOf(absent), true);
  assert.equal(policyOf(stays), true);
  assert.equal(policyOf(optsOut), false);
});

test('flag on: a step of five reads runs four at once, then the fifth', LATCH_TIMEOUT, async () => {
  const probe = createProbe();
  const run = await runCase(
    // No call returns before four have started. A lower cap never gets there
    // (the test stops at its timeout); a higher one starts the fifth beside them.
    caseConfig({ probe, features: FLAG_ON, hold: () => probe.whenStarted(4) }),
    [
      calls(
        ['lookup', 'A-1'],
        ['lookup', 'B-2'],
        ['lookup', 'C-3'],
        ['lookup', 'D-4'],
        ['lookup', 'E-5']
      ),
      answer()
    ]
  );
  assert.equal(probe.maxInFlight, 4);
  assert.deepEqual(probe.started, ['A-1', 'B-2', 'C-3', 'D-4', 'E-5']);
  assert.deepEqual(
    run.ledger
      .filter(event => event.type === 'tool/call')
      .map(event => [event.data.callId, event.data.parallelGroup, event.data.callIndex]),
    [
      ['call_1', 0, 0],
      ['call_2', 0, 1],
      ['call_3', 0, 2],
      ['call_4', 0, 3],
      // Alone in the second batch: a group of one names no place.
      ['call_5', 1, undefined]
    ]
  );
  assert.deepEqual(
    toolResults(run.requests[1]).map(([id]) => id),
    ['call_1', 'call_2', 'call_3', 'call_4', 'call_5']
  );
});

// ── an app that runs as a tool ──────────────────────────────────────────────

/**
 * Run the desk app the way another app, the MCP gateway or the A2A endpoint
 * runs it: on the run service with a headless host, a run of the kind `subagent`.
 *
 * @param {Object} config - From {@link caseConfig}.
 * @param {Object[]} script - The turns of the scripted model.
 */
async function runAsTool(config, script) {
  const env = await startGoldenEnv(config);
  try {
    env.model = scriptedModel(script);
    const { context } = requestRunContext(
      env.principal({ id: 'golden-user', name: 'Golden User', groups: ['users'] })
    );
    const result = await new RunService({ chatService: env.chatService }).run(
      appRunSpec({
        context,
        appId: 'desk',
        messages: [{ role: 'user', content: 'Look up the records.' }]
      }),
      new HeadlessHost()
    );
    await env.settle();
    const ledger = [...env.ledger];
    return {
      result,
      kinds: ledger.filter(event => event.type === 'run/start').map(event => event.data.kind),
      toolCalls: ledger
        .filter(event => event.type === 'tool/call')
        .map(event => [event.data.callId, event.data.callIndex]),
      requests: env.model.requests
    };
  } finally {
    await env.stop();
  }
}

test(
  'an app run as a tool, flag off: the calls run one at a time, as before',
  LATCH_TIMEOUT,
  async () => {
    // Two reads, and two writes with different arguments (what the mode
    // `targets` would put side by side).
    for (const [tool, keys] of [
      ['lookup', ['A-1', 'B-2']],
      ['store', ['S-1', 'S-2']]
    ]) {
      const probe = createProbe();
      const run = await runAsTool(caseConfig({ probe }), [
        calls([tool, keys[0]], [tool, keys[1]]),
        answer()
      ]);
      assert.deepEqual(run.kinds, ['subagent'], 'the run is the one of an app called as a tool');
      assert.equal(run.result.status, 'ok');
      assert.equal(probe.maxInFlight, 1, tool);
      assert.deepEqual(probe.started, keys);
      assert.deepEqual(probe.ended, keys);
      assert.deepEqual(run.toolCalls, [
        ['call_1', undefined],
        ['call_2', undefined]
      ]);
    }
  }
);

test(
  'an app run as a tool, flag on: two reads overlap and the model gets them in call order',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    const run = await runAsTool(
      caseConfig({ probe, features: FLAG_ON, hold: () => probe.whenStarted(2) }),
      [calls(['lookup', 'A-1'], ['lookup', 'B-2']), answer()]
    );
    assert.deepEqual(run.kinds, ['subagent']);
    assert.equal(probe.maxInFlight, 2);
    assert.deepEqual(run.toolCalls, [
      ['call_1', 0],
      ['call_2', 1]
    ]);
    assert.deepEqual(toolResults(run.requests[1]), [
      ['call_1', { key: 'A-1', value: 'record A-1' }],
      ['call_2', { key: 'B-2', value: 'record B-2' }]
    ]);
    assert.equal(run.result.status, 'ok');
    assert.equal(run.result.finalMessage.content, 'The records are open.');
  }
);

test(
  'an app run as a tool, flag on: a write in the step, or two writes, run one call at a time',
  LATCH_TIMEOUT,
  async () => {
    for (const step of [
      [
        ['lookup', 'A-1'],
        ['store', 'S-9'],
        ['lookup', 'B-2']
      ],
      [
        ['store', 'S-1'],
        ['store', 'S-2']
      ]
    ]) {
      const probe = createProbe();
      const run = await runAsTool(caseConfig({ probe, features: FLAG_ON }), [
        calls(...step),
        answer()
      ]);
      const keys = step.map(([, key]) => key);
      assert.equal(probe.maxInFlight, 1, keys.join(' '));
      assert.deepEqual(probe.started, keys);
      assert.deepEqual(probe.ended, keys);
      assert.ok(
        run.toolCalls.every(([, callIndex]) => callIndex === undefined),
        'no call names a place in a batch'
      );
    }
  }
);

test(
  'an app run as a tool, flag on, its model opts out: the calls run one at a time',
  LATCH_TIMEOUT,
  async () => {
    const probe = createProbe();
    const run = await runAsTool(
      caseConfig({ probe, features: FLAG_ON, model: { parallelToolCalls: false } }),
      [calls(['lookup', 'A-1'], ['lookup', 'B-2']), answer()]
    );
    assert.deepEqual(run.kinds, ['subagent']);
    assert.equal(probe.maxInFlight, 1);
    assert.deepEqual(probe.started, ['A-1', 'B-2']);
  }
);
