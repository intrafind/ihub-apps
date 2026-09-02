/**
 * Projection of an SSE v2 `interaction` (contracts/interaction.js) back onto
 * the legacy workflow `checkpoint` shape that `HumanCheckpoint.jsx` renders:
 *
 *   { id, nodeId, nodeName, type, message, title, options, inputSchema,
 *     showData, displayData, expiresAt, timeout, createdAt }
 *
 * Shared by the chat projection (`features/chat/runToMessage.js`) and the
 * workflow projection (`features/workflows/workflowRunProjection.js`) so both
 * surfaces rebuild exactly the same checkpoint from the same interaction.
 *
 * @module shared/run/interactionToCheckpoint
 */

/** interaction.kind → legacy checkpoint.type */
const KIND_TO_CHECKPOINT_TYPE = Object.freeze({
  approval: 'approval',
  review: 'review',
  question: 'input'
});

/**
 * True when an interaction originates from a workflow `human` node checkpoint
 * (as opposed to a chat `ask_user` clarification).
 *
 * @param {Object|null} interaction
 * @returns {boolean}
 */
export function isCheckpointInteraction(interaction) {
  return !!(interaction && interaction.source && interaction.source.checkpointId);
}

/**
 * True when an interaction is a chat clarification question (`ask_user`).
 *
 * @param {Object|null} interaction
 * @returns {boolean}
 */
export function isClarificationInteraction(interaction) {
  return !!(
    interaction &&
    interaction.kind === 'question' &&
    interaction.prompt &&
    !isCheckpointInteraction(interaction)
  );
}

/**
 * Rebuild the legacy checkpoint object from an interaction.
 *
 * @param {Object} interaction - SSE v2 interaction
 * @returns {Object|null} checkpoint or null when the interaction is not one
 */
export function interactionToCheckpoint(interaction) {
  if (!interaction) return null;
  const prompt = interaction.prompt || {};
  const source = interaction.source || {};
  const policy = interaction.policy || {};
  return {
    id: source.checkpointId || interaction.id,
    nodeId: source.nodeId,
    ...(source.nodeName ? { nodeName: source.nodeName } : {}),
    type: KIND_TO_CHECKPOINT_TYPE[interaction.kind] || 'approval',
    message: prompt.message,
    ...(prompt.title !== undefined ? { title: prompt.title } : {}),
    ...(prompt.options !== undefined ? { options: prompt.options } : {}),
    inputSchema: prompt.inputSchema ?? null,
    showData: prompt.showData ?? null,
    ...(prompt.displayData !== undefined ? { displayData: prompt.displayData } : {}),
    expiresAt: policy.expiresAt ?? null,
    timeout: policy.timeoutMs ?? null,
    ...(interaction.createdAt ? { createdAt: interaction.createdAt } : {})
  };
}
