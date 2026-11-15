// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The evidence record built from a real run journal: `RunLog` over a
 * filesystem provider, request headers written by `LLMClient` itself so the
 * `initial` / `append` / `same` / `change` dedupe and the ledger copies of
 * documents and pictures are the ones production writes.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_LOG_EVENTS } from '../../shared/runEvents.js';
import { documentBlock } from '../../shared/promptContext.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { RunLog, hashPayload } from '../services/loop/RunLog.js';
import { LLMClient } from '../services/loop/LLMClient.js';
import { ledgerMessages } from '../services/loop/ledgerMessages.js';
import { buildEvidence } from '../services/chat/evidenceRecord.js';
import { contentItem } from '../services/chat/ChatEvidenceRepository.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

let root;
let provider;
let runLog;
let client;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-evidence-record-'));
  provider = new FilesystemStorageProvider({ baseDir: root, flushIntervalMs: 25 });
  await provider.initialize();
  runLog = new RunLog({
    forceEnabled: true,
    getPlatformConfig: () => ({ runLog: { spillThresholdBytes: 64 * 1024 } }),
    bus: {
      request: async () => null,
      respond: () => () => {},
      hasRemote: () => false,
      createPresenceMap: () => new Map()
    },
    logs: provider.logs,
    documents: provider.documents,
    locks: provider.locks
  });
  client = new LLMClient({ runLog });
});

after(async () => {
  await provider.shutdown?.();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const TOOLS = [
  { type: 'function', function: { name: 'search', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'read', parameters: { type: 'object' } } }
];

/** Record one request header the way a model call does. */
function header(runId, requestId, step, messages, { tools = TOOLS, temperature = 0.2 } = {}) {
  client._recordRequestHeader({
    runId,
    step,
    requestId,
    model: { id: 'gpt-test', provider: 'openai', modelId: 'gpt-4o' },
    request: { body: { messages } },
    messages,
    adapterOptions: { tools, maxTokens: 1024, temperature, stream: true },
    telemetry: { segment: 'main', purpose: 'answer' },
    language: 'en'
  });
}

/** Resolve a `sha256:` reference to its parsed item. */
function item(items, ref) {
  const text = items.get(ref.replace(/^sha256:/, ''));
  assert.ok(text !== undefined, `item ${ref} is collected`);
  return JSON.parse(text);
}

describe('buildEvidence', () => {
  it('replays history, references files, folds tools, retries and errors', async () => {
    const { runId } = await runLog.startRun({
      kind: 'chat',
      user: { id: 'u1' },
      refs: { chatId: 'chat-1', appId: 'app-1' }
    });

    const doc = { fileId: 'f1', fileName: 'a.pdf', content: 'the document text', chatFile: true };
    const picture = Buffer.from('picture bytes');
    const system = { role: 'system', content: 'You are helpful.' };
    const user = {
      role: 'user',
      content: `${documentBlock(doc)}\nSummarize`,
      fileData: [doc],
      imageData: [{ base64: picture.toString('base64'), fileId: 'img1', fileType: 'image/png' }]
    };
    const first = [system, user];
    header(runId, 'req-1', 0, first);
    runLog.append(runId, RUN_LOG_EVENTS.KNOWLEDGE_SCOPE, {
      projects: [{ id: 'p1', mode: 'loaded', documents: 3 }]
    });
    runLog.append(runId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {
      step: 0,
      requestId: 'req-1',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'search', arguments: '{"q":"x"}' }],
      finishReason: 'tool_calls'
    });

    // Three tool calls: a spilled result, an inline one the next header
    // carries, and one the model never saw (only its preview is left).
    const fullResult = JSON.stringify({ hits: 'x'.repeat(500) });
    const spillRef = await runLog.spill(runId, 'tool-0-call-1', fullResult);
    for (const [callId, extra] of [
      ['call-1', { spillRef, resultPreview: fullResult.slice(0, 20) }],
      ['call-2', { resultPreview: 'inline' }],
      ['call-3', { resultPreview: 'only the preview' }]
    ]) {
      runLog.append(runId, RUN_LOG_EVENTS.TOOL_CALL, {
        step: 0,
        callId,
        toolId: 'search',
        name: 'search',
        integration: 'Intranet',
        activityKind: 'search',
        args: { q: callId }
      });
      runLog.append(runId, RUN_LOG_EVENTS.TOOL_RESULT, {
        step: 0,
        callId,
        toolId: 'search',
        name: 'search',
        durationMs: 5,
        resultBytes: 10,
        ...extra
      });
    }

    const second = [
      ...first,
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }, { id: 'call-2' }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"truncated":true}' },
      { role: 'tool', tool_call_id: 'call-2', content: 'inline result' }
    ];
    header(runId, 'req-2', 1, second);
    runLog.append(runId, RUN_LOG_EVENTS.REQUEST_RETRY, {
      step: 1,
      requestId: 'req-2',
      attempt: 1,
      code: 'RATE_LIMITED',
      status: 429,
      delayMs: 10
    });
    runLog.append(runId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {
      step: 1,
      requestId: 'req-2',
      content: 'partial',
      finishReason: 'stop'
    });

    header(runId, 'req-3', 2, second);
    runLog.append(runId, RUN_LOG_EVENTS.ERROR, {
      step: 2,
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'too long',
      recoverable: true
    });

    // Compaction rewrote the history: a `change` header with fewer messages.
    const compacted = [system, { role: 'user', content: 'summary of the conversation' }];
    header(runId, 'req-4', 3, compacted, { temperature: 0.5 });
    runLog.append(runId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {
      step: 3,
      requestId: 'req-4',
      content: 'The answer',
      finishReason: 'stop'
    });

    const { record, items } = await buildEvidence({
      runLog,
      runId,
      chatId: 'chat-1',
      messageId: 'msg-1',
      summary: { status: 'completed', content: 'The answer', finishReason: 'stop' },
      artifacts: [{ id: 'art-1', sha256: 'a'.repeat(64) }]
    });

    assert.equal(record.v, 1);
    assert.equal(record.chatId, 'chat-1');
    assert.equal(record.messageId, 'msg-1');
    assert.equal(record.journalEnded, false, 'no run/end yet (recovery case)');
    assert.equal(record.app.id, 'app-1');
    assert.equal(record.model.id, 'gpt-test');
    assert.equal(record.model.settings.temperature, 0.2);
    assert.equal(record.output.contentSha256, sha256('The answer'));
    assert.deepEqual(record.output.files, [{ artifactId: 'art-1', sha256: 'a'.repeat(64) }]);
    assert.deepEqual(record.knowledge, [{ projectId: 'p1', mode: 'loaded', documents: 3 }]);

    // Calls: initial, append, same, change — each with its full history.
    assert.deepEqual(
      record.calls.map(call => [call.requestId, call.status, call.messages.length]),
      [
        ['req-1', 'ok', 1],
        ['req-2', 'ok', 4],
        ['req-3', 'error', 4],
        ['req-4', 'ok', 1]
      ]
    );
    for (const [call, real] of [
      [record.calls[0], first],
      [record.calls[1], second],
      [record.calls[2], second],
      [record.calls[3], compacted]
    ]) {
      assert.equal(call.messagesHash, hashPayload(real), 'messagesHash as computed at the call');
      const rebuilt = [...call.system, ...call.messages.map(m => m.message)].map(ref =>
        item(items, ref)
      );
      assert.deepEqual(rebuilt, ledgerMessages(real), 'the messages the call was sent');
    }
    assert.deepEqual(
      record.calls[0].tools.map(ref => item(items, ref)),
      TOOLS,
      'tool definitions'
    );
    assert.equal(record.calls[1].attempt, 2);
    assert.deepEqual(record.calls[1].retries, [{ attempt: 1, code: 'RATE_LIMITED', status: 429 }]);
    assert.equal(record.calls[2].error.code, 'CONTEXT_WINDOW_EXCEEDED');
    assert.equal(item(items, record.calls[3].config).optionsSnapshot.temperature, 0.5);

    // The user message names its document and picture as chat files.
    assert.deepEqual(record.calls[0].messages[0].files, [
      { fileId: 'img1', sha256: sha256(picture), bytes: picture.length },
      { fileId: 'f1', textSha256: sha256(doc.content), chars: doc.content.length }
    ]);

    const byCall = Object.fromEntries(record.toolCalls.map(call => [call.callId, call]));
    assert.equal(byCall['call-1'].resultSource, 'spill');
    assert.equal(item(items, byCall['call-1'].result), fullResult);
    assert.equal(byCall['call-2'].resultSource, 'message');
    assert.equal(item(items, byCall['call-2'].result), 'inline result');
    assert.equal(byCall['call-3'].resultSource, 'preview');
    assert.equal(byCall['call-3'].partial, true);
    assert.deepEqual(item(items, byCall['call-1'].args), { q: 'call-1' });
    assert.equal(byCall['call-1'].integration, 'Intranet');
    assert.equal(byCall['call-1'].activityKind, 'search');

    // Every item is stored under the hash of its text.
    for (const [hash, text] of items) assert.equal(contentItem(JSON.parse(text)).sha256, hash);
  });

  it('records journalEnded and the end status when the run ended', async () => {
    const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
    header(runId, 'req-a', 0, [{ role: 'user', content: 'hi' }], { tools: null });
    runLog.append(runId, RUN_LOG_EVENTS.MESSAGE_ASSISTANT, {
      step: 0,
      requestId: 'req-a',
      content: 'hello',
      finishReason: 'stop'
    });
    runLog.endRun(runId, { status: 'completed', finishReason: 'stop' });
    const { record } = await buildEvidence({ runLog, runId, summary: { content: 'hello' } });
    assert.equal(record.journalEnded, true);
    assert.equal(record.status, 'completed');
    assert.equal(record.finishReason ?? record.output.finishReason, 'stop');
    assert.equal(record.calls[0].tools, undefined);
  });
});
