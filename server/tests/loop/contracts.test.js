/**
 * T1 — contract snapshot tests for the unified runtime.
 *
 * The Zod schemas in server/services/loop/contracts are THE spec. This test
 * exports them to JSON Schema and compares against a committed snapshot so any
 * change to a contract is a visible, reviewed diff.
 *
 * Update intentionally with: UPDATE_SNAPSHOTS=1 node --test server/tests/loop/contracts.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as contracts from '../../services/loop/contracts/index.js';
import {
  RUN_LOG_EVENT_LIST,
  SSE_V2_EVENT_LIST,
  INTERACTION_KINDS
} from '../../../shared/runEvents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(__dirname, '__snapshots__', 'contracts.schema.json');

const SNAPSHOTTED = [
  'runLogEventSchema',
  'interactionSchema',
  'interactionAnswerRequestSchema',
  'humanEventSchema',
  'loopRequestSchema',
  'loopResultSchema',
  'llmRequestSchema',
  'sseV2EventSchema',
  'usageSchema',
  'principalSchema'
];

function exportAll() {
  const out = {};
  for (const name of SNAPSHOTTED) {
    out[name] = zodToJsonSchema(contracts[name], { name, $refStrategy: 'none' });
  }
  out.LLM_ERROR_CODES = contracts.LLM_ERROR_CODE_LIST;
  out.RUN_LOG_EVENTS = RUN_LOG_EVENT_LIST;
  out.SSE_V2_EVENTS = SSE_V2_EVENT_LIST;
  out.INTERACTION_KINDS = INTERACTION_KINDS;
  return out;
}

test('contract JSON-schema snapshot is unchanged', () => {
  const current = JSON.stringify(exportAll(), null, 2) + '\n';
  if (process.env.UPDATE_SNAPSHOTS === '1' || !fs.existsSync(SNAPSHOT)) {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, current, 'utf8');
    return;
  }
  const committed = fs.readFileSync(SNAPSHOT, 'utf8');
  // Structural comparison: formatting of the snapshot file (Prettier) must not fail the test.
  assert.deepEqual(
    JSON.parse(current),
    JSON.parse(committed),
    'Contract schemas changed. If intentional, re-run with UPDATE_SNAPSHOTS=1 and review the diff.'
  );
});

test('every RunLog event type has a data schema and validates a minimal payload', () => {
  const minimal = {
    'run/start': { kind: 'chat', principal: { id: 'u', mode: 'default' } },
    'run/end': { status: 'completed' },
    'run/paused': { reason: 'interaction' },
    'run/resumed': {},
    'segment/start': { segment: 's1', purpose: 'title' },
    'request/header': {
      step: 1,
      requestId: 'r1',
      model: 'm',
      provider: 'openai',
      requestHash: 'h',
      messagesHash: 'mh',
      messageCount: 1,
      reason: 'initial',
      toolSchemasHash: null
    },
    'request/retry': { step: 1, requestId: 'r1', attempt: 1, code: 'RATE_LIMITED', delayMs: 10 },
    'message/user': { step: 0, content: 'hi' },
    'message/assistant': { step: 1, content: 'hello' },
    'tool/call': { step: 1, callId: 'c', toolId: 't', name: 't', args: {} },
    'tool/result': {
      step: 1,
      callId: 'c',
      toolId: 't',
      name: 't',
      resultPreview: {},
      durationMs: 1
    },
    'tool/disabled': { step: 1, toolId: 't', reason: 'rate_limited', failures: 2 },
    'interaction/raised': {
      interaction: {
        id: 'i',
        runId: 'r',
        kind: 'question',
        origin: 'tool',
        prompt: { message: 'q' },
        createdAt: new Date().toISOString()
      }
    },
    'interaction/answered': {
      interactionId: 'i',
      kind: 'question',
      answer: { value: 'yes', by: 'u', at: new Date().toISOString() }
    },
    'human/event': { kind: 'stop', by: 'u', at: new Date().toISOString() },
    'budget/checkpoint': { step: 1, usage: {}, runUsage: {} },
    'budget/exhausted': { step: 1, reason: 'tokens' },
    'context/compaction': { step: 1, trigger: 'proactive', collapsed: 1, freedChars: 10 },
    error: { code: 'PROVIDER_ERROR', message: 'x' }
  };
  for (const type of RUN_LOG_EVENT_LIST) {
    assert.ok(contracts.runLogEventDataSchemas[type], `missing data schema for ${type}`);
    assert.ok(minimal[type], `test fixture missing for ${type}`);
    contracts.parseRunLogEventData(type, minimal[type]);
    contracts.runLogEventSchema.parse({
      seq: 1,
      ts: new Date().toISOString(),
      runId: 'run-1',
      type,
      data: minimal[type]
    });
  }
});

test('every SSE v2 event type has a data schema', () => {
  for (const type of SSE_V2_EVENT_LIST) {
    assert.ok(contracts.sseV2EventDataSchemas[type], `missing data schema for ${type}`);
  }
  assert.throws(() => contracts.parseSseV2EventData('nope', {}), /Unknown SSE v2 event type/);
});

test('LLMError carries a canonical code and falls back to PROVIDER_ERROR', () => {
  const e = new contracts.LLMError('boom', { code: 'RATE_LIMITED', status: 429, retryAfterMs: 50 });
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfterMs, 50);
  const unknown = new contracts.LLMError('x', { code: 'SOMETHING_ELSE' });
  assert.equal(unknown.code, 'PROVIDER_ERROR');
  assert.equal(unknown.retryable, false);
  const ctx = new contracts.LLMError('x', { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 });
  assert.equal(ctx.isContextWindowError, true);
  assert.equal(contracts.isLLMError(ctx), true);
  assert.equal(contracts.isLLMError(new Error('plain')), false);
});

test('loopRequest defaults policies and toolExecution', () => {
  const req = contracts.loopRequestSchema.parse({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }]
  });
  assert.equal(req.toolExecution, 'server');
  assert.equal(req.policies.budgets.maxToolRounds, 10);
  assert.equal(req.policies.tools.maxRateLimitFailures, 2);
  assert.equal(req.policies.context.compactThresholdTokens, 16000);
  assert.equal(req.policies.interactions.maxQuestions, 10);
});

test('request bodies: an answer must say something; a steer must carry a message', () => {
  const { interactionAnswerRequestSchema, humanEventRequestSchema } = contracts;
  assert.equal(interactionAnswerRequestSchema.safeParse({}).success, false);
  assert.equal(interactionAnswerRequestSchema.safeParse({ skipped: true }).success, true);
  assert.equal(interactionAnswerRequestSchema.safeParse({ value: 'yes' }).success, true);
  assert.equal(interactionAnswerRequestSchema.safeParse({ decision: 'approve' }).success, true);
  assert.equal(humanEventRequestSchema.safeParse({ kind: 'steer' }).success, false);
  assert.equal(humanEventRequestSchema.safeParse({ kind: 'steer', message: '   ' }).success, false);
  assert.equal(humanEventRequestSchema.safeParse({ kind: 'steer', message: 'go' }).success, true);
  assert.equal(humanEventRequestSchema.safeParse({ kind: 'stop' }).success, true);
});
