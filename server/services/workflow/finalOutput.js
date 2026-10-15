/**
 * What a finished workflow hands back as its output.
 *
 * A workflow ends at an end step, and every end step has an `output`
 * (`EndNodeExecutor`): the answer a chat shows and an API, MCP or A2A caller
 * receives. Next to it the output carries whatever else the end step passes on.
 * So the workflow's output is the output of the end step the run finished at,
 * as it built it.
 *
 * A run can also finish at a step that is not an end step: a step that
 * short-circuits the run (an empty inbox, for one) completes it where it is.
 * Such a run has no end step and so no `output` of its own; it hands back what
 * its last step produced.
 *
 * @module services/workflow/finalOutput
 */

/**
 * @param {Object} state - Execution state of the finished run
 * @param {Object} [workflow] - The workflow definition that ran. Callers do not all
 *   store it in the state, so the engine hands it over; the state's is the fallback.
 * @returns {*} The workflow's output; `undefined` when the last step left none
 */
export function finalOutputOf(state, workflow) {
  const data = state?.data || {};
  const definition = workflow || data._workflowDefinition;
  const lastNodeId = state?.completedNodes?.[state.completedNodes.length - 1];
  const lastNode = definition?.nodes?.find(node => node.id === lastNodeId);
  const lastResult = data.nodeResults?.[lastNodeId];

  // An end step: its own output, `output` and all.
  if (lastNode?.type === 'end' && lastResult && lastResult.output !== undefined) {
    return lastResult.output;
  }

  // Any other last step. A step that lists output variables keeps handing
  // those back; otherwise the step's result is the output.
  const outputVariables = lastNode?.config?.outputVariables;
  if (Array.isArray(outputVariables)) {
    const output = {};
    for (const name of outputVariables) {
      if (data[name] !== undefined) output[name] = data[name];
    }
    return output;
  }
  return lastResult;
}
