/**
 * Pure projection of one SSE v2 RunState (shared/run/runReducer.js) onto the
 * assistant chat message that `ChatMessage.jsx` renders.
 *
 *   projectRunToMessage(run) → { content, loading, extras }
 *
 * `extras` carries exactly the message fields the chat UI reads today:
 * thoughts, images, clarification/awaitingInput/clarificationAnswered,
 * workflowCheckpoint, workflowSteps/workflowStep, workflowResult/outputFormat,
 * activeSkills, searchStatus, searchSummary, toolActivity, mcpApps, mcpAuthRequired, citations,
 * groundingSources,
 * answerSource, finishReason, ifinderMessageId. The hook (`useAppChat`) only decides WHEN to write the
 * projection and which message it belongs to — it never interprets events.
 *
 * @module features/chat/runToMessage
 */
import { isRunFinished, getInteractions } from '../../../../shared/run/runReducer.js';
import { buildToolActivity } from '../../../../shared/run/toolActivity.js';
import {
  answerSourceOf,
  buildWorkflowSteps,
  groundingSourcesOf,
  settleWorkflowSteps,
  workflowResultOf
} from '../../../../shared/run/runActivity.js';
import { buildMcpAppViews } from './mcpApps/mcpAppViewList';
import { buildMcpAuthPrompts } from './mcpApps/mcpConnectPrompts';
import {
  interactionToCheckpoint,
  isCheckpointInteraction,
  isClarificationInteraction
} from '../../shared/run/interactionToCheckpoint';

/** Fallback when a stream/error frame carries no message (callers pass the translated string). */
export const DEFAULT_STREAM_ERROR_MESSAGE = 'An error occurred during streaming';

/**
 * Fold a list of citation payloads with the same semantics as
 * `useChatMessages.mergeCitations`: a later payload's `references` /
 * `resultItems` replace the earlier ones only when present.
 *
 * @param {Array<Object>} entries - `[{ references?, resultItems? }, …]`
 * @returns {{ references: Array, resultItems: Array }|null} merged citations or null when empty
 */
export function mergeCitationEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let merged = {};
  for (const next of entries) {
    if (!next || typeof next !== 'object') continue;
    merged = {
      references: next.references || merged.references || [],
      resultItems: next.resultItems || merged.resultItems || []
    };
  }
  return Object.keys(merged).length ? merged : null;
}

/**
 * Build the `clarification` message field from an `ask_user` interaction.
 *
 * @param {Object} interaction - interaction of kind `question` (with prompt)
 * @returns {Object} clarification as ClarificationCard expects it
 */
export function buildClarification(interaction) {
  const prompt = interaction.prompt || {};
  const source = interaction.source || {};
  return {
    questionId: interaction.id,
    toolCallId: source.toolCallId,
    question: prompt.message,
    inputType: prompt.inputType || 'text',
    options: prompt.options || [],
    allowOther: prompt.allowOther || false,
    allowSkip: prompt.allowSkip || false,
    context: prompt.context,
    ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.validation !== undefined ? { validation: prompt.validation } : {}),
    clarificationNumber: interaction.ordinal,
    maxClarifications: interaction.maxClarifications
  };
}

function last(list, predicate) {
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) return list[i];
  return null;
}

/**
 * Project a run onto the assistant message.
 *
 * @param {Object|null} run - RunState from the run reducer
 * @param {Object} [options]
 * @param {string} [options.fallbackErrorMessage] - Used when a stream/error frame has no message
 * @returns {{ content: string, loading: boolean, extras: Object }}
 */
export function projectRunToMessage(run, options = {}) {
  if (!run) return { content: '', loading: false, extras: {} };
  const fallbackErrorMessage = options.fallbackErrorMessage || DEFAULT_STREAM_ERROR_MESSAGE;
  const extras = {};
  const finished = isRunFinished(run);
  const interactions = getInteractions(run);
  // The run behind the message: feedback and human events are recorded on it.
  if (run.runId) extras.runId = run.runId;

  // ── content ───────────────────────────────────────────────────────────
  let content = run.text || '';
  if (run.error) {
    // Legacy 'error' path: the error text is appended to whatever streamed.
    content = `${content}\n\n${run.error.message || fallbackErrorMessage}`;
  }

  // ── reasoning / media ────────────────────────────────────────────────
  if (run.thinking?.length) extras.thoughts = run.thinking;
  if (run.images?.length) extras.images = run.images;

  // ── clarification (ask_user) ─────────────────────────────────────────
  const question = last(interactions, isClarificationInteraction);
  let awaitingQuestion = false;
  if (question) {
    extras.clarification = buildClarification(question);
    if (question.status === 'pending' && !finished) {
      awaitingQuestion = true;
      extras.awaitingInput = true;
    } else if (question.status === 'pending') {
      // Turn ended (status paused) while the question is still open.
      awaitingQuestion = true;
      extras.awaitingInput = true;
    } else {
      extras.awaitingInput = false;
      extras.clarificationAnswered = true;
    }
  }

  // ── chat-launched workflow: checkpoint, steps, result ────────────────
  const workflow = run.meta?.extra?.workflow;
  const checkpoint = last(interactions, isCheckpointInteraction);
  if (checkpoint) {
    extras.workflowCheckpoint =
      checkpoint.status === 'pending' && !workflow && !finished
        ? {
            checkpoint: interactionToCheckpoint(checkpoint),
            executionId: checkpoint.source?.executionId
          }
        : null;
  }

  const steps = buildWorkflowSteps(run);
  if (steps.length) {
    extras.workflowSteps = steps;
    extras.workflowStep = last(steps, s => s.status === 'running');
  }
  if (workflow) {
    extras.workflowSteps = settleWorkflowSteps(steps, workflow.status);
    extras.workflowStep = null;
    extras.workflowCheckpoint = null;
    extras.workflowResult = workflowResultOf(run);
    extras.outputFormat = workflow.outputFormat || 'markdown';
  }

  // ── tool side channels ───────────────────────────────────────────────
  if (run.skills?.length) extras.activeSkills = run.skills;
  if (run.searchStatus !== null && run.searchStatus !== undefined) {
    extras.searchStatus = run.searchStatus;
  }
  // Outlives the streaming phase on purpose: what the turn searched for and
  // how much it found is part of the answer's provenance, not a progress
  // spinner, so the finished message keeps showing it.
  if (run.searchSummary) extras.searchSummary = run.searchSummary;
  const citations = mergeCitationEntries(run.citations);
  if (citations) extras.citations = citations;
  // Sources behind a grounded answer (provider-run web search).
  const groundingSources = groundingSourcesOf(run);
  if (groundingSources.length) extras.groundingSources = groundingSources;
  // The searches the turn ran, the pages they found and read, and the other
  // tools it called. Like the search summary, it stays with the finished
  // answer as provenance.
  const toolActivity = buildToolActivity(run);
  if (toolActivity) extras.toolActivity = toolActivity;
  // Interactive MCP App views the turn's tools rendered.
  const mcpApps = buildMcpAppViews(run);
  if (mcpApps) extras.mcpApps = mcpApps;
  // MCP servers with per-user sign-in the user has to connect (one per server).
  const mcpAuthRequired = buildMcpAuthPrompts(run);
  if (mcpAuthRequired) extras.mcpAuthRequired = mcpAuthRequired;
  // Scheduled tasks a scheduling tool proposed: confirmation cards.
  const scheduledTaskProposals = (run.tools || [])
    .map(tool => tool.scheduledTaskProposal)
    .filter(proposal => proposal && typeof proposal.proposalId === 'string');
  if (scheduledTaskProposals.length) extras.scheduledTaskProposals = scheduledTaskProposals;

  // ── completion metadata ──────────────────────────────────────────────
  if (finished) {
    const answerSource = answerSourceOf(run);
    if (answerSource) extras.answerSource = answerSource;
    if (run.finishReason !== null && run.finishReason !== undefined) {
      extras.finishReason = run.finishReason;
    }
  }
  if (run.meta?.responseMessageId) extras.ifinderMessageId = run.meta.responseMessageId;

  // ── loading ──────────────────────────────────────────────────────────
  // Streaming while the run is running; a workflow checkpoint pause keeps the
  // spinner (the turn continues once the checkpoint is answered) while a
  // clarification pause hands control back to the user.
  const loading =
    !run.error && (run.status === 'running' || (run.status === 'paused' && !awaitingQuestion));

  return { content, loading, extras };
}

/**
 * Project a message that spans a chat run and the workflow runs a tool launched
 * inside it (child runs: `parentRunId === run.runId`). The answer text,
 * lifecycle and completion metadata come from the chat run; the workflow state
 * (steps, checkpoint, result, output format) comes from the children — a
 * child's lifecycle never completes the message, the chat run does.
 *
 * @param {Object} run - the chat run (parent)
 * @param {Object[]} [childRuns] - workflow runs whose `parentRunId` is `run.runId`
 * @param {Object} [options] - see projectRunToMessage
 * @returns {{ content: string, loading: boolean, extras: Object }}
 */
export function projectMessageRuns(run, childRuns = [], options = {}) {
  const base = projectRunToMessage(run, options);
  if (!childRuns || childRuns.length === 0) return base;
  const extras = { ...base.extras };
  let steps = extras.workflowSteps ? [...extras.workflowSteps] : [];
  for (const child of childRuns) {
    const c = projectRunToMessage(child, options).extras;
    if (c.workflowSteps?.length) steps = [...steps, ...c.workflowSteps];
    if (c.workflowStep !== undefined) extras.workflowStep = c.workflowStep;
    if (c.workflowCheckpoint !== undefined) extras.workflowCheckpoint = c.workflowCheckpoint;
    if (c.workflowResult) extras.workflowResult = c.workflowResult;
    if (c.outputFormat && !extras.outputFormat) extras.outputFormat = c.outputFormat;
  }
  if (steps.length) extras.workflowSteps = steps;
  return { ...base, extras };
}

export default projectRunToMessage;
