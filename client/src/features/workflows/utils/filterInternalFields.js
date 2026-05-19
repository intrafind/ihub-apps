/**
 * Set of state field names that should be hidden from end users.
 * These are internal workflow engine artifacts (definitions, paused state,
 * iteration tracking) that have no meaning to the person running the workflow.
 *
 * Also filters out any key starting with `_`, plus the human-response
 * input/output bookkeeping fields.
 */
const INTERNAL_FIELDS = new Set([
  'nodeResults',
  '_nodeIterations',
  '_workflowDefinition',
  '_workflow',
  'pendingCheckpoint',
  '_pausedAt',
  '_pauseReason',
  '_resumedAt',
  '_modelOverride'
]);

/**
 * Returns a copy of the workflow state's `data` object with internal/engine
 * fields removed, so it can be displayed to non-technical users.
 *
 * @param {Object|null|undefined} data - The `state.data` from useWorkflowExecution.
 * @returns {Object} Filtered object containing only user-facing fields.
 */
export function getDisplayableOutput(data) {
  if (!data) return {};

  const output = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      INTERNAL_FIELDS.has(key) ||
      key.startsWith('_') ||
      key.startsWith('humanResponse_') ||
      key.startsWith('_humanResult_')
    ) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

export { INTERNAL_FIELDS };
