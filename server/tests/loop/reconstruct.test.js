/**
 * T5 — a run recorded through LLMClient can be rebuilt from its ledger and the
 * rebuilt provider request hashes to what was sent (report-only check).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient } from '../../services/loop/LLMClient.js';
import {
  verifyRequestReconstruction,
  verifyRunReconstruction,
  optionsFromCallConfig
} from '../../services/loop/replay/reconstruct.js';
import { captureRunLog, sseResponse, openaiText, MODELS } from './helpers/llmFixtures.js';

const model = MODELS.openai; // real OpenAI adapter, autoDiscovery:false keeps it offline

function realClient(runLog) {
  return new LLMClient({
    runLog,
    transport: async () => sseResponse(openaiText(['ok'])),
    apiKeyVerifier: { verifyApiKey: async () => ({ success: true, apiKey: 'sk-live' }) },
    getModels: () => ({ data: [model] })
  });
}

test('optionsFromCallConfig — round-trips the recorded call configuration', () => {
  const options = optionsFromCallConfig(
    {
      temperature: 0.3,
      maxTokens: 512,
      responseFormat: 'json',
      thinking: { thinkingEnabled: false },
      stream: true
    },
    { tools: [{ id: 't' }] }
  );
  assert.deepEqual(options, {
    temperature: 0.3,
    maxTokens: 512,
    responseFormat: 'json',
    thinkingEnabled: false,
    stream: true,
    tools: [{ id: 't' }]
  });
});

test('a multi-step run reconstructs byte-for-byte through the real adapter', async () => {
  const { runLog, events } = await captureRunLog();
  const client = realClient(runLog);
  const { runId } = await runLog.startRun({ kind: 'agent', user: { id: 'u1' } });
  const tools = [
    {
      id: 'get_weather',
      name: 'get_weather',
      description: 'w',
      parameters: { type: 'object', properties: {} }
    }
  ];
  const messages = [{ role: 'user', content: 'hello' }];
  await client.complete({
    model,
    messages,
    options: { temperature: 0.2, maxTokens: 300, tools },
    telemetry: { runId, step: 0 }
  });
  // same messages, same tools → 'same' header without messages
  await client.complete({
    model,
    messages,
    options: { temperature: 0.2, maxTokens: 300, tools },
    telemetry: { runId, step: 1 }
  });
  // changed messages, tools dropped
  await client.complete({
    model,
    messages: [
      ...messages,
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'more' }
    ],
    options: { temperature: 0.7 },
    telemetry: { runId, step: 2 }
  });
  await runLog.flush();

  const report = await verifyRequestReconstruction(events, {
    findModel: id => (id === model.id ? model : null)
  });
  assert.equal(report.checked, 3, JSON.stringify(report, null, 2));
  assert.equal(report.matched, 3, JSON.stringify(report.mismatched, null, 2));
  assert.deepEqual(report.skipped, []);
  assert.equal(report.ok, true);

  // The same check from disk.
  const fromDisk = await verifyRunReconstruction(runLog, runId, { findModel: () => model });
  assert.equal(fromDisk.matched, 3);
  await runLog.stop();
});

test('tampered messages are detected; schema-constrained calls are verified; unknown models are skipped', async () => {
  const { runLog, events } = await captureRunLog();
  const client = realClient(runLog);
  const { runId } = await runLog.startRun({ kind: 'agent', user: { id: 'u1' } });
  await client.complete({
    model,
    messages: [{ role: 'user', content: 'a' }],
    telemetry: { runId, step: 0 }
  });
  await client.complete({
    model,
    messages: [{ role: 'user', content: 'b' }],
    options: { responseFormat: 'json', responseSchema: { type: 'object' } },
    telemetry: { runId, step: 1 }
  });
  const tampered = events.map(e =>
    e.type === 'request/header' && e.data.step === 0
      ? { ...e, data: { ...e.data, messages: [{ role: 'user', content: 'TAMPERED' }] } }
      : e
  );
  const report = await verifyRequestReconstruction(tampered, { findModel: () => model });
  assert.equal(report.checked, 2);
  assert.equal(report.mismatched.length, 1);
  assert.equal(
    report.matched,
    1,
    'the schema-constrained request is rebuilt from the recorded schema'
  );
  assert.deepEqual(report.skipped, []);
  assert.equal(report.ok, false);

  // The schema is recorded once (on change) and referenced by hash afterwards;
  // a header whose hash has no recorded schema is skipped, not guessed.
  const headers = events.filter(e => e.type === 'request/header');
  assert.equal(headers[0].data.callConfig.responseSchema, undefined);
  assert.deepEqual(headers[1].data.callConfig.responseSchema, { type: 'object' });
  const withoutSchema = events.map(e =>
    e.type === 'request/header' && e.data.step === 1
      ? {
          ...e,
          data: { ...e.data, callConfig: { ...e.data.callConfig, responseSchema: undefined } }
        }
      : e
  );
  const partial = await verifyRequestReconstruction(withoutSchema, { findModel: () => model });
  assert.equal(partial.skipped.length, 1);
  assert.match(partial.skipped[0].reason, /schema/);

  const unknown = await verifyRequestReconstruction(events, { findModel: () => null });
  assert.equal(unknown.checked, 0);
  assert.equal(unknown.skipped.length, 2);
  await runLog.stop();
});
