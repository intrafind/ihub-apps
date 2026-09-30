/**
 * What a run did before it answered — its provenance — in the message fields
 * the chat renders beside the answer.
 *
 *   buildRunActivity(run, childRuns) → { toolActivity, searchSummary, groundingSources,
 *     activeSkills, answerSource, workflowSteps, workflowResult, outputFormat } | null
 *
 * One projection for two moments. While a turn streams, the client projects
 * its live run state with these builders (`runToMessage.js`). When the turn
 * ends, the server folds the same frames with the same reducer and stores
 * this object on the answer (`services/chat/runActivity.js`), so a chat
 * reopened a week later shows the searches, tool calls and workflow steps the
 * user watched live — rendered by the same components, from the same shapes.
 *
 * Pure and dependency-free apart from its siblings, so both sides import it.
 *
 * @module shared/run/runActivity
 */
import { isRunFinished } from './runReducer.js';
import { buildToolActivity } from './toolActivity.js';
import { extractGroundingSources } from './groundingSources.js';

/** progress/node status → chat step status (WorkflowStepIndicator vocabulary). */
const NODE_STATUS_TO_STEP_STATUS = Object.freeze({ failed: 'error' });

/**
 * Chat step list from the run's `progress/node` entries:
 *   - status 'running'  → every other running step becomes 'completed', new step appended
 *   - any other status  → replaces the step with the same nodeName, else appended
 *
 * @param {Object} run - RunState
 * @returns {Array<{nodeName, nodeType, status, workflowName, chatVisible}>}
 */
export function buildWorkflowSteps(run) {
  let steps = [];
  for (const entry of run?.progress || []) {
    if (entry.kind !== 'progress/node') continue;
    const step = {
      nodeName: entry.nodeName,
      nodeType: entry.nodeType,
      status: NODE_STATUS_TO_STEP_STATUS[entry.status] || entry.status,
      workflowName: entry.progress?.workflowName,
      chatVisible: entry.progress?.chatVisible
    };
    if (step.status === 'running') {
      steps = steps.map(s => (s.status === 'running' ? { ...s, status: 'completed' } : s));
      steps = [...steps, step];
    } else {
      const exists = steps.some(s => s.nodeName === step.nodeName);
      steps = exists ? steps.map(s => (s.nodeName === step.nodeName ? step : s)) : [...steps, step];
    }
  }
  return steps;
}

/**
 * The steps of a workflow that has reported its result: a step still marked
 * running finished with the workflow — completed, or failed with it.
 *
 * @param {Array<Object>} steps - see {@link buildWorkflowSteps}
 * @param {string} status - the workflow's result status
 * @returns {Array<Object>}
 */
export function settleWorkflowSteps(steps, status) {
  return steps.map(s =>
    s.status === 'running' ? { ...s, status: status === 'failed' ? 'error' : 'completed' } : s
  );
}

/**
 * The result a chat-launched workflow reported (`meta.extra.workflow`), in the
 * shape the step indicator and the answer badge read, or null while it runs.
 *
 * @param {Object} run - RunState
 * @returns {{status: string, executionId?: string, workflowName?: string}|null}
 */
export function workflowResultOf(run) {
  const workflow = run?.meta?.extra?.workflow;
  if (!workflow) return null;
  return {
    status: workflow.status,
    executionId: run.meta?.executionId,
    workflowName: workflow.workflowName
  };
}

/**
 * Sources behind a grounded answer (provider-run web search). A completed
 * step carries the server-merged metadata of that step; while streaming, the
 * progress frames merged by the reducer stand in.
 *
 * @param {Object} run - RunState
 * @returns {Array<Object>}
 */
export function groundingSourcesOf(run) {
  const stepGrounding = Object.values(run?.steps || {})
    .map(step => step.groundingMetadata)
    .filter(Boolean);
  return extractGroundingSources(stepGrounding.length ? stepGrounding : run?.grounding);
}

/**
 * The knowledge the answer drew on, for the answer badge ("Based on web
 * search", "… iFinder"). Only once the run is over: the list grows while it runs.
 *
 * @param {Object} run - RunState
 * @returns {{sources: string[], type: 'mixed'}|null}
 */
export function answerSourceOf(run) {
  if (!isRunFinished(run) || !run.knowledgeSources?.length) return null;
  return { sources: run.knowledgeSources, type: 'mixed' };
}

/**
 * The provenance of a finished message: the chat run behind it and the
 * workflow runs a tool launched inside it (`parentRunId === run.runId`), or
 * the workflow run itself for an `@mention` launch.
 *
 * Every field is left out when the run has nothing for it, and null comes
 * back when the run did nothing worth showing — a plain answer from the
 * model's own knowledge.
 *
 * @param {Object|null} run - RunState of the message's own run
 * @param {Object[]} [childRuns] - workflow runs started inside it
 * @returns {Object|null}
 */
export function buildRunActivity(run, childRuns = []) {
  if (!run) return null;
  const activity = {};

  const toolActivity = buildToolActivity(run);
  // `reading` is the page a search is fetching right now: never true of a
  // finished run, and meaningless once stored.
  if (toolActivity) activity.toolActivity = { items: toolActivity.items, reading: null };
  if (run.searchSummary) activity.searchSummary = { ...run.searchSummary, searching: false };
  const groundingSources = groundingSourcesOf(run);
  if (groundingSources.length) activity.groundingSources = groundingSources;
  if (run.skills?.length) activity.activeSkills = run.skills;
  const answerSource = answerSourceOf(run);
  if (answerSource) activity.answerSource = answerSource;

  let steps = [];
  for (const workflowRun of [run, ...(childRuns || [])]) {
    const result = workflowResultOf(workflowRun);
    const own = buildWorkflowSteps(workflowRun);
    // Each workflow settles its own steps. One that never reported a result
    // (the run was stopped or failed around it) did not leave a step running,
    // whatever another workflow of the same turn reported.
    steps = [
      ...steps,
      ...(result
        ? settleWorkflowSteps(own, result.status)
        : own.map(s => (s.status === 'running' ? { ...s, status: 'stopped' } : s)))
    ];
    if (result) {
      activity.workflowResult = result;
      if (!activity.outputFormat) {
        activity.outputFormat = workflowRun.meta.extra.workflow.outputFormat || 'markdown';
      }
    }
  }
  if (steps.length) activity.workflowSteps = steps;

  return Object.keys(activity).length ? activity : null;
}
