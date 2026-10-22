// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A file or recording sent to a transcription model selected in a stored chat
 * is stored as a turn: the file as the question, the transcript as the answer
 * (`services/chat/transcriptionTurn.js`), so the chat model selected next
 * answers from it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { ChatRepository } from '../services/chat/ChatRepository.js';
import {
  beginTranscriptionTurn,
  endTranscriptionTurn
} from '../services/chat/transcriptionTurn.js';
import { INTERRUPTED_RUN_GRACE_MS, isChatRunAlive } from '../services/chat/chatRecovery.js';
import runLog from '../services/loop/RunLog.js';

const user = { id: 'alice', permissions: { apps: new Set(['notes']), models: new Set(['*']) } };
const attachment = { name: 'meeting.mp3', type: 'audio/mpeg', bytes: 1234 };

function quietLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

async function withRepository(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-transcription-turn-'));
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  const repository = new ChatRepository({
    documents: provider.documents,
    locks: provider.locks,
    logger: quietLogger()
  });
  try {
    await fn(repository);
  } finally {
    await provider.shutdown();
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

const begin = (repository, extra = {}) =>
  beginTranscriptionTurn({
    repository,
    storage: { stored: true, temporary: false },
    user,
    chatId: 'chat-transcribe',
    appId: 'notes',
    modelId: 'gemini-3.5-transcribe',
    clientMessageId: 'exchange-1',
    attachment,
    ...extra
  });

describe('transcription turn', () => {
  it('stores the file as the question and the transcript as the answer of the model', async () => {
    await withRepository(async repository => {
      const result = await begin(repository);
      assert.equal(result.ok, true);
      assert.ok(result.turn);

      const chat = await repository.getChat('chat-transcribe');
      assert.equal(chat.activeRunId, result.turn.runId);

      // A long recording is a live run, not one interrupted after the grace period.
      const later = Date.now() + INTERRUPTED_RUN_GRACE_MS + 60_000;
      assert.equal(isChatRunAlive(chat, { now: later }), true);
      assert.equal(runLog.getRunMeta(result.turn.runId)?.ended, false);

      await endTranscriptionTurn(result.turn, { content: 'Hello everyone, welcome.' });
      assert.equal(runLog.getRunMeta(result.turn.runId)?.ended, true);

      const { messages } = await repository.getMessages('chat-transcribe');
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'meeting.mp3');
      assert.equal(messages[0].clientMessageId, 'exchange-1');
      assert.deepEqual(messages[0].attachments, [
        { type: 'audio/mpeg', name: 'meeting.mp3', bytes: 1234 }
      ]);
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, 'Hello everyone, welcome.');
      assert.equal(messages[1].model, 'gemini-3.5-transcribe');
      // Marked, so the client offers no edit or resend: the audio is not kept.
      assert.equal(messages[0].transcription, true);
      assert.equal(messages[1].transcription, true);
      assert.equal((await repository.getChat('chat-transcribe')).activeRunId ?? null, null);
    });
  });

  it('a transcript cut short is stored with the error', async () => {
    await withRepository(async repository => {
      const { turn } = await begin(repository);
      await endTranscriptionTurn(turn, {
        content: 'Hello every',
        error: 'Transcription service closed the connection (code 1011)'
      });
      const { messages } = await repository.getMessages('chat-transcribe');
      assert.equal(messages[1].content, 'Hello every');
      assert.ok(messages[1].error);
    });
  });

  it('stores nothing without storage or when no chat is named', async () => {
    await withRepository(async repository => {
      assert.deepEqual(await begin(repository, { storage: { stored: false, temporary: true } }), {
        ok: true,
        turn: null
      });
      assert.deepEqual(await begin(repository, { chatId: undefined }), { ok: true, turn: null });
      assert.equal(await repository.getChat('chat-transcribe'), null);
      // Ending a turn that was never stored is a no-op.
      await endTranscriptionTurn(null, { content: 'x' });
    });
  });

  it("refuses a chat that is not the user's, and an app the user may not use", async () => {
    await withRepository(async repository => {
      const { turn } = await begin(repository);
      await endTranscriptionTurn(turn, { content: 'mine' });

      const mallory = { id: 'mallory', permissions: { apps: new Set(['*']) } };
      assert.deepEqual(await begin(repository, { user: mallory }), {
        ok: false,
        code: 'not-permitted'
      });
      assert.deepEqual(await begin(repository, { appId: 'hr' }), {
        ok: false,
        code: 'not-permitted'
      });
      const { messages } = await repository.getMessages('chat-transcribe');
      assert.equal(messages.length, 2);
    });
  });

  it('a question that cannot be stored refuses the turn instead of transcribing for nothing', async () => {
    await withRepository(async repository => {
      const failing = Object.create(repository);
      failing.appendMessage = async () => null;
      assert.deepEqual(await begin(failing), { ok: false, code: 'not-stored' });
    });
  });

  it('an answer that cannot be stored is reported, and its run ends as an error', async () => {
    await withRepository(async repository => {
      const { turn } = await begin(repository);
      const original = repository.appendMessage.bind(repository);
      repository.appendMessage = async () => null;
      const stored = await endTranscriptionTurn(turn, { content: 'Hello everyone.' });
      repository.appendMessage = original;
      assert.equal(stored, false);
      assert.equal(runLog.getRunMeta(turn.runId)?.ended, true);
    });
  });

  it('a stored answer reports so', async () => {
    await withRepository(async repository => {
      const { turn } = await begin(repository);
      assert.equal(await endTranscriptionTurn(turn, { content: 'Hello.' }), true);
      assert.equal(await endTranscriptionTurn(null, { content: 'x' }), true);
    });
  });
});
