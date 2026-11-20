// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A chat in which every turn has tool rounds: the model asks for a tool, iHub
 * runs it and calls the model again with the result, one to three times, before
 * the answer comes. This is the load of an agent, where one message of a user
 * is several model calls and several tool calls.
 *
 * It runs in the app and on the model that setup.mjs registers for it
 * (`setup.agent`): an app that binds iHub's own tools and the fake LLM as a
 * model that is offered tools. The tool is `list_scheduled_tasks`, which only
 * reads and needs no network.
 *
 * With the fake LLM the number of tool rounds is exact: the message carries the
 * marker of `lib/stubTools.mjs`. A turn that ran fewer tool calls than asked for
 * is counted (`agentTurn.toolRounds.short`) and, unless
 * `scenarios.agentTurn.requireToolRounds` is false, fails: the app does not
 * offer the tool, or the model was registered without tools. A real model
 * decides for itself; switch the requirement off for it.
 */

import { ChatSession } from '../lib/chat.mjs';
import { toolMarker } from '../lib/stubTools.mjs';

const PROMPTS = [
  'Which scheduled tasks do I have? Summarise them in two sentences.',
  'Look at my scheduled tasks and tell me which one runs next.',
  'Do I have a scheduled task that runs every week? Check and answer briefly.',
  'List my scheduled tasks and say which of them failed last time.'
];

const FOLLOW_UPS = [
  'Check again and tell me whether anything changed.',
  'Look once more: is there a task I should delete?',
  'Check the list again and give me only the names.'
];

export default async function agentTurn(ctx) {
  const s = ctx.config.scenarios.agentTurn;
  const agent = ctx.config.setup.agent;
  const session = await new ChatSession(ctx, { appId: agent.appId, label: 'agentTurn' }).open();
  try {
    const turns = ctx.between(s.turns);
    for (let t = 0; t < turns && ctx.isActive(); t++) {
      const rounds = ctx.between(s.toolRounds);
      const base = t === 0 ? ctx.pick(PROMPTS) : ctx.pick(FOLLOW_UPS);
      const result = await session.turn({
        content: `${base} ${ctx.config.answerLengthHint} ${toolMarker(s.tool, rounds)}`.trim(),
        // This scenario's own model: the one that is offered tools.
        body: { modelId: agent.modelId, ephemeral: Boolean(s.ephemeral) }
      });
      if (result.tools < rounds) {
        ctx.metrics.count('agentTurn.toolRounds.short');
        if (s.requireToolRounds !== false) {
          ctx.metrics.error('agentTurn', 'TOOL_ROUNDS_SHORT');
          const err = new Error(
            `agentTurn: ${result.tools} tool calls instead of ${rounds} (does ${agent.appId} offer ${s.tool}?)`
          );
          err.code = 'TOOL_ROUNDS_SHORT';
          throw err;
        }
      }
      if (t < turns - 1) await ctx.think();
    }
  } finally {
    session.close();
  }
}
