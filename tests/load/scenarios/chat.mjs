// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Plain multi-turn chat with the configured app and model: the bulk of real
 * traffic. The prompts ask for a bounded answer length so a real-LLM run has a
 * predictable token cost.
 */

import { ChatSession } from '../lib/chat.mjs';

const PROMPTS = [
  'Write a short project status update for a software migration that is two weeks late.',
  'Explain the difference between a process and a thread to a new colleague.',
  'Draft a polite email declining a meeting invitation and proposing two alternative dates.',
  'Give me five ideas to make our weekly team meeting more effective.',
  'Summarize the main risks of introducing generative AI in customer support.',
  'Explain what a reverse proxy does and when you need one.',
  'Create a checklist for preparing a quarterly business review.',
  'Rewrite this sentence to sound more professional: we kinda missed the deadline because stuff happened.',
  'What should a good incident post-mortem contain?',
  'Compare Kanban and Scrum in a short table.'
];

const FOLLOW_UPS = [
  'Make it shorter.',
  'Now translate that into German.',
  'Add one concrete example.',
  'Turn that into a bulleted list.',
  'What would be the first step?'
];

export default async function chat(ctx) {
  const s = ctx.config.scenarios.chat;
  const session = await new ChatSession(ctx, { appId: ctx.config.appId, label: 'chat' }).open();
  try {
    const turns = ctx.between(s.turns);
    for (let t = 0; t < turns && ctx.isActive(); t++) {
      const base = t === 0 ? ctx.pick(PROMPTS) : ctx.pick(FOLLOW_UPS);
      await session.turn({
        content: `${base} ${ctx.config.answerLengthHint}`.trim(),
        body: { ephemeral: Boolean(s.ephemeral) }
      });
      if (t < turns - 1) await ctx.think();
    }
  } finally {
    session.close();
  }
}
