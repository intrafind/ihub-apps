// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat with an uploaded document: upload the file the way the UI does
 * (`POST /api/chats/{chatId}/files`, multipart field `file`), then ask about it
 * over several turns. Server-side extraction (PDF/Office → text) and file
 * storage are part of what this measures.
 */

import { performance } from 'node:perf_hooks';
import { ChatSession, newChatId } from '../lib/chat.mjs';
import { multipart, questionsFor } from '../lib/fixtures.mjs';
import { HttpError } from '../lib/http.mjs';

export default async function chatFile(ctx) {
  const s = ctx.config.scenarios.chatFile;
  const { client, metrics } = ctx;
  const candidates = ctx.fixtures.filter(f => f.buffer.length <= s.maxFileBytes);
  const file = ctx.pick(candidates.length ? candidates : ctx.fixtures);
  const chatId = newChatId();

  const t0 = performance.now();
  const res = await client.request('POST', `/api/chats/${chatId}/files`, {
    form: multipart(file, {
      appId: ctx.config.appId,
      ...(s.ephemeral ? { ephemeral: 'true' } : {})
    }),
    name: 'chatFile.upload'
  });
  if (res.status !== 201 && res.status !== 200)
    throw new HttpError('chatFile.upload', res.status, res.body);
  metrics.trend(`chatFile.upload.${sizeClass(file.buffer.length)}`, performance.now() - t0);
  metrics.count('chatFile.uploadedBytes', file.buffer.length);
  const fileId = res.body?.id;

  const session = await new ChatSession(ctx, {
    appId: ctx.config.appId,
    chatId,
    label: 'chatFile'
  }).open();
  try {
    const questions = questionsFor(file.topic);
    const turns = ctx.between(s.turns);
    for (let t = 0; t < turns && ctx.isActive(); t++) {
      await session.turn({
        content:
          `${t === 0 ? questions[0] : ctx.pick(questions)} ${ctx.config.answerLengthHint}`.trim(),
        fileIds: t === 0 && fileId ? [fileId] : undefined,
        body: { ephemeral: Boolean(s.ephemeral) }
      });
      if (t < turns - 1) await ctx.think();
    }
  } finally {
    session.close();
  }
}

export function sizeClass(bytes) {
  if (bytes < 50_000) return 'small';
  if (bytes < 500_000) return 'medium';
  return 'large';
}
