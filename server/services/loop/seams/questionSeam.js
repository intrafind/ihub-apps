/**
 * Interactive tools → interactions. A tool marked `interactive: true` (today:
 * `ask_user`) never executes; the seam raises a `question` interaction through
 * the supplied `raise` callback, appends the "awaiting user response" tool
 * message and pauses the segment. A per-conversation cap turns further
 * questions into an error result the model has to work around.
 *
 *   questionSeam({ raise(info, ctx) → interaction, validate(args) → { valid, error },
 *                  getCount(key, ctx), incrementCount(key, ctx), maxQuestions,
 *                  headless, onRejected(reason, info, ctx, payload) })
 *
 * `headless: true` (no user can answer — app-as-tool, MCP, scheduled runs)
 * turns every question into a `NO_USER_AVAILABLE` error result instead of
 * pausing a turn nobody resumes.
 *
 * @module services/loop/seams/questionSeam
 */

/**
 * Tools that ask the user (today `ask_user`, or anything flagged
 * `requiresUserInput`) are `interactive` for the question seam. Every caller
 * that offers tools to the loop (chat, workflow and agent nodes) marks them.
 * @param {Array} tools
 * @returns {Array}
 */
export function markInteractiveTools(tools) {
  return (Array.isArray(tools) ? tools : []).map(tool =>
    tool && (tool.id === 'ask_user' || tool.requiresUserInput === true) && tool.interactive !== true
      ? { ...tool, interactive: true }
      : tool
  );
}

export function questionSeam({
  raise,
  validate,
  getCount,
  incrementCount,
  maxQuestions,
  key,
  headless = false,
  onRejected
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
      if (headless) {
        // No user can answer (app-as-tool, MCP, scheduled runs): hand the
        // model an explicit refusal instead of pausing a turn nobody resumes.
        const payload = {
          error: true,
          message:
            'No user is available to answer questions in this context. Proceed with the available information or make reasonable assumptions.',
          code: 'NO_USER_AVAILABLE'
        };
        await onRejected?.('headless', info, ctx, payload);
        return { handled: true, execution: 'clarification', message: toolMessage(payload) };
      }
      const cap = Number.isInteger(maxQuestions)
        ? maxQuestions
        : ctx.policies.interactions.maxQuestions;
      const counterKey = key ? key(ctx) : ctx.refs.chatId || ctx.runId || 'run';
      const count = getCount ? getCount(counterKey, ctx) : ctx._questionCount || 0;
      if (cap > 0 && count >= cap) {
        const payload = {
          error: true,
          message: `Maximum clarification limit (${cap}) reached for this conversation. Please proceed with the available information or make reasonable assumptions.`,
          code: 'CLARIFICATION_LIMIT_REACHED'
        };
        await onRejected?.('limit', info, ctx, payload);
        return { handled: true, execution: 'clarification', message: toolMessage(payload) };
      }
      if (validate) {
        const verdict = validate(info.args);
        if (verdict && verdict.valid === false) {
          const payload = {
            error: true,
            message: `Invalid clarification request: ${verdict.error}`,
            code: 'INVALID_CLARIFICATION_PARAMS'
          };
          await onRejected?.('invalid', info, ctx, payload);
          return { handled: true, execution: 'clarification', message: toolMessage(payload) };
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
