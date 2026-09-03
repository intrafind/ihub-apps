/**
 * Question pause — how a prompt / agent node pauses its execution when the
 * model calls `ask_user`, and how it resumes the same step from the answer
 * (concept §5.5, C5: workflows and agent profiles raise the identical
 * `question` kind).
 *
 * The node's loop raises a durable `question` interaction (question seam) and
 * ends with `status: 'paused'`. The node then returns a paused result carrying
 * a checkpoint (so the run page, the chat bridge and the interactions queue
 * show it exactly like a `human` node checkpoint) and persists the loop's
 * transcript under `state.data._pausedLoops[nodeId]`. Answering the
 * interaction stores the answer under `state.data._questionAnswers[id]` and
 * resumes the execution; the node runs again, finds its paused transcript and
 * continues the loop with the answer as the `ask_user` tool result.
 *
 * @module services/workflow/questionPause
 */

function localizedName(node, language) {
  if (!node) return '';
  if (typeof node.name === 'string') return node.name;
  if (node.name && typeof node.name === 'object') {
    return node.name[language] || node.name.en || Object.values(node.name)[0] || node.id;
  }
  return node.id;
}

/**
 * The checkpoint shown for a paused question (same shape `HumanCheckpoint`
 * renders for `human` nodes, `type: 'question'`).
 */
export function buildQuestionCheckpoint({ node, interaction, language = 'en' }) {
  const prompt = interaction?.prompt || {};
  return {
    id: String(interaction.id),
    nodeId: node.id,
    nodeName: localizedName(node, language) || node.id,
    type: 'question',
    message: String(prompt.message || ''),
    inputType: prompt.inputType || 'text',
    ...(Array.isArray(prompt.options) && prompt.options.length ? { options: prompt.options } : {}),
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    allowSkip: prompt.allowSkip === true,
    ...(prompt.validation ? { validation: prompt.validation } : {}),
    ...(prompt.context ? { context: prompt.context } : {}),
    inputSchema: null,
    showData: null,
    timeout: interaction.policy?.timeoutMs || null,
    createdAt: interaction.createdAt || new Date().toISOString(),
    expiresAt: interaction.policy?.expiresAt || null,
    interactionId: String(interaction.id)
  };
}

/** What the node persists so the same step can continue after the answer. */
export function pausedLoopState({ checkpointId, toolCallId = null, messages = [] }) {
  return {
    checkpointId: String(checkpointId),
    toolCallId: toolCallId ? String(toolCallId) : null,
    messages: Array.isArray(messages) ? messages : [],
    pausedAt: new Date().toISOString()
  };
}

/** The `ask_user` tool result the model sees once the human answered. */
export function answeredToolContent(answer = {}) {
  if (answer.skipped) {
    return JSON.stringify({
      status: 'skipped',
      message: 'The user skipped this question. Proceed with the available information.'
    });
  }
  return JSON.stringify({ status: 'answered', answer: answer.value ?? null });
}

/**
 * Rebuild the loop transcript for a resumed node: the paused transcript with
 * the awaiting `ask_user` tool message replaced by the answer.
 *
 * @param {Object|null} pausedLoop - `state.data._pausedLoops[nodeId]`
 * @param {Object|null} answer - `state.data._questionAnswers[checkpointId]`
 * @returns {Array|null} messages, or null when there is nothing to resume
 */
export function resumeTranscript(pausedLoop, answer) {
  if (!pausedLoop || !Array.isArray(pausedLoop.messages) || !answer) return null;
  const content = answeredToolContent(answer);
  let replaced = false;
  const messages = pausedLoop.messages.map(m => {
    if (
      !replaced &&
      m &&
      m.role === 'tool' &&
      (pausedLoop.toolCallId ? m.tool_call_id === pausedLoop.toolCallId : true) &&
      typeof m.content === 'string' &&
      m.content.includes('awaiting_user_response')
    ) {
      replaced = true;
      return { ...m, content };
    }
    return m;
  });
  if (!replaced) {
    // The awaiting message is gone (compacted?): hand the answer over as a
    // user message so the model still receives it.
    messages.push({ role: 'user', content: `Answer to your question: ${content}`, _steer: true });
  }
  return messages;
}

export default { buildQuestionCheckpoint, pausedLoopState, answeredToolContent, resumeTranscript };
