// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * API integrations: the OpenAI-compatible Inference API with streaming.
 * No chat persistence and no SSE relay, so it isolates the LLM path.
 */

import { inferenceTurn } from '../lib/chat.mjs';

const PROMPTS = [
  'Classify this ticket as bug, question or feature request: "Export to PDF crashes on large tables."',
  'Extract the company names from: "IntraFind partners with Acme Corp and Globex on search."',
  'Summarize in one sentence: the quarterly numbers improved because cloud revenue grew 20 percent.'
];

export default async function inference(ctx) {
  const s = ctx.config.scenarios.inference;
  const model = s.model || (ctx.config.modelId ? ctx.config.modelId : `app:${ctx.config.appId}`);
  const n = ctx.between(s.requests);
  for (let i = 0; i < n && ctx.isActive(); i++) {
    await inferenceTurn(ctx, {
      model,
      messages: [
        { role: 'user', content: `${ctx.pick(PROMPTS)} ${ctx.config.answerLengthHint}`.trim() }
      ]
    });
    await ctx.sleep(ctx.between(s.pauseSec) * 1000);
  }
}
