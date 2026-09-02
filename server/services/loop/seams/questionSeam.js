/**
 * Interactive tools → interactions. A tool marked `interactive: true` (today:
 * `ask_user`) never executes; the seam raises a `question` interaction through
 * the supplied `raise` callback, appends the "awaiting user response" tool
 * message and pauses the segment. A per-conversation cap turns further
 * questions into an error result the model has to work around.
 *
 *   questionSeam({ raise(info, ctx) → interaction, validate(args) → { valid, error },
 *                  getCount(key, ctx), incrementCount(key, ctx), maxQuestions })
 *
 * @module services/loop/seams/questionSeam
 */

export function questionSeam({
  raise,
  validate,
  getCount,
  incrementCount,
  maxQuestions,
  key
} = {}) {
  return {
    name: 'question',
    async preTool(ctx, info) {
      const { toolDef, call } = info;
      if (!toolDef || toolDef.interactive !== true) return null;
      const toolMessage = payload => ({
        role: 'tool',
        tool_call_id: call.id,
        name: info.name,
        content: JSON.stringify(payload)
      });
      const cap = Number.isInteger(maxQuestions)
        ? maxQuestions
        : ctx.policies.interactions.maxQuestions;
      const counterKey = key ? key(ctx) : ctx.refs.chatId || ctx.runId || 'run';
      const count = getCount ? getCount(counterKey, ctx) : ctx._questionCount || 0;
      if (cap > 0 && count >= cap) {
        return {
          handled: true,
          execution: 'clarification',
          message: toolMessage({
            error: true,
            message: `Maximum clarification limit (${cap}) reached for this conversation. Please proceed with the available information or make reasonable assumptions.`,
            code: 'CLARIFICATION_LIMIT_REACHED'
          })
        };
      }
      if (validate) {
        const verdict = validate(info.args);
        if (verdict && verdict.valid === false) {
          return {
            handled: true,
            execution: 'clarification',
            message: toolMessage({
              error: true,
              message: `Invalid clarification request: ${verdict.error}`,
              code: 'INVALID_CLARIFICATION_PARAMS'
            })
          };
        }
      }
      const nextCount = count + 1;
      if (incrementCount) incrementCount(counterKey, ctx);
      else ctx._questionCount = nextCount;
      const interaction = await raise({ ...info, ordinal: nextCount, max: cap }, ctx);
      return {
        handled: true,
        execution: 'clarification',
        message: toolMessage({
          status: 'awaiting_user_response',
          message: 'Clarification request sent to user. Waiting for response.',
          clarificationNumber: nextCount
        }),
        terminate: {
          status: 'paused',
          finishReason: 'clarification',
          pendingInteraction: interaction
        }
      };
    }
  };
}
