// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Heavy use of projects in chats: a multi-turn chat inside a prepared project
 * (`projectId` on the chat POST). The server injects project text into the
 * prompt (whole corpus if it fits, else BM25 sections) and offers the
 * knowledge_* tools, so this exercises decryption, the per-process corpus index
 * (LRU of 32 projects) and much larger prompts than a plain chat.
 *
 * Projects come from setup.mjs (names starting with "LT-chat"): the user's own
 * and the shared ones. Which one a session picks is controlled by
 * `scenarios.projectChat.preferShared` (0..1).
 */

import { ChatSession } from '../lib/chat.mjs';
import { questionsFor } from '../lib/fixtures.mjs';

export default async function projectChat(ctx) {
  const s = ctx.config.scenarios.projectChat;
  const { own, shared } = ctx.projects;
  let pool = Math.random() < s.preferShared ? shared : own;
  if (pool.length === 0) pool = own.length ? own : shared;
  if (pool.length === 0) {
    const err = new Error('no LT-chat project visible to this user — run setup.mjs first');
    err.code = 'NO_PROJECT';
    throw err;
  }
  const project = ctx.pick(pool);
  const topic = /topic=(\w+)/.exec(project.description || '')?.[1] || null;
  const questions = questionsFor(topic);

  const session = await new ChatSession(ctx, {
    appId: ctx.config.appId,
    label: 'projectChat'
  }).open();
  try {
    const turns = ctx.between(s.turns);
    for (let t = 0; t < turns && ctx.isActive(); t++) {
      await session.turn({
        content: `${ctx.pick(questions)} ${ctx.config.answerLengthHint}`.trim(),
        body: { projectId: project.id, ephemeral: Boolean(s.ephemeral) }
      });
      if (t < turns - 1) await ctx.think();
    }
  } finally {
    session.close();
  }
}
