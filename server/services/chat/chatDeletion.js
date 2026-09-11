/**
 * Deleting a chat and everything the chat owns.
 *
 * A chat document is not the whole conversation. Each turn it recorded left a
 * run in the ledger — the prompt, the answer, the tool arguments, any spilled
 * payloads — and an `@mention` turn additionally left a workflow execution
 * whose state document carries the chat history it was launched with. The
 * confirmation the user answers says the conversation is "removed for good",
 * so all of it has to go, not just the two chat documents.
 *
 * Both callers that delete a chat — the DELETE route and the retention sweep —
 * go through here, because a cascade written twice is a cascade that grows a
 * third limb in one copy only.
 *
 * @module services/chat/chatDeletion
 */
import logger from '../../utils/logger.js';

/**
 * Run one cascade step without letting it strand the rest.
 *
 * Every step is best-effort on purpose: the chat itself is already gone by the
 * time these run, so a failure here is leftovers to sweep rather than an
 * outcome to report, and throwing would only invite a retry that can now
 * only 404.
 *
 * @param {() => Promise<unknown>} step - The cascade step.
 * @param {string} what - What is being removed, for the log line.
 * @param {{component: string, chatId: string, runId: string}} where - Log context.
 * @returns {Promise<void>}
 */
async function attempt(step, what, where) {
  try {
    await step();
  } catch (error) {
    logger.error(`Failed to cascade a chat delete into ${what}`, {
      ...where,
      error: error.message
    });
  }
}

/**
 * Delete a chat and cascade into the runs it recorded.
 *
 * @param {import('./ChatRepository.js').ChatRepository} repository - Chat repository.
 * @param {string} chatId - Chat to remove.
 * @param {Object} deps
 * @param {(runId: string) => Promise<unknown>} deps.deleteRun - Ledger cascade;
 *   the single entry point that removes a run's ledger file, its spill
 *   directory and its pending interactions.
 * @param {(runId: string) => Promise<unknown>} deps.removeWorkflowState -
 *   Workflow-state cascade. Kept as an explicit step here rather than
 *   registered as a `runLog.onDelete` hook: that hook fires for *every* run
 *   deletion, the ledger retention sweep included, and would then remove the
 *   state of a paused execution that workflow retention deliberately keeps
 *   longer than the ledger. Deleting the chat is the one event that really
 *   does mean the execution's content goes with it.
 * @param {string} deps.component - Log component of the caller.
 * @returns {Promise<{deleted: boolean, runIds: string[]}>}
 */
export async function deleteChatWithCascade(
  repository,
  chatId,
  { deleteRun, removeWorkflowState, component }
) {
  // The chat document is the only place a chat's runs are recorded, so it has
  // to be read before it is removed — `deleteChat` returns them for exactly
  // this reason.
  const { deleted, runIds } = await repository.deleteChat(chatId);
  for (const runId of runIds) {
    const where = { component, chatId, runId };
    await attempt(() => deleteRun(runId), 'one of its runs', where);
    await attempt(() => removeWorkflowState(runId), 'the workflow state of one of its runs', where);
  }
  return { deleted, runIds };
}

export default deleteChatWithCascade;
