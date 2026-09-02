/**
 * Pure projection of one SSE v2 RunState (shared/run/runReducer.js) onto the
 * assistant chat message that `ChatMessage.jsx` renders.
 *
 *   projectRunToMessage(run) → { content, loading, extras }
 *
 * `extras` carries exactly the message fields the chat UI reads today:
 * thoughts, images, clarification/awaitingInput/clarificationAnswered,
 * workflowCheckpoint, workflowSteps/workflowStep, workflowResult/outputFormat,
 * activeSkills, searchStatus, citations, answerSource, finishReason,
 * ifinderMessageId. The hook (`useAppChat`) only decides WHEN to write the
 * projection and which message it belongs to — it never interprets events.
 *
 * @module features/chat/runToMessage
 */
import { isRunFinished, getInteractions } from '../../shared/run/runReducer';
import {
  interactionToCheckpoint,
  isCheckpointInteraction,
  isClarificationInteraction
} from '../../shared/run/interactionToCheckpoint';

/** Fallback when a stream/error frame carries no message (callers pass the translated string). */
export const DEFAULT_STREAM_ERROR_MESSAGE = 'An error occurred during streaming';

/** progress/node status → chat step status (WorkflowStepIndicator vocabulary). */
const NODE_STATUS_TO_STEP_STATUS = Object.freeze({ failed: 'error' });

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
 * Chat step list from the run's `progress/node` entries, replayed with the
 * exact semantics of `useChatMessages.appendWorkflowStep`:
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

  let steps = buildWorkflowSteps(run);
  if (steps.length) {
    extras.workflowSteps = steps;
    extras.workflowStep = last(steps, s => s.status === 'running');
  }
  if (workflow) {
    steps = steps.map(s =>
      s.status === 'running'
        ? { ...s, status: workflow.status === 'failed' ? 'error' : 'completed' }
        : s
    );
    extras.workflowSteps = steps;
    extras.workflowStep = null;
    extras.workflowCheckpoint = null;
    extras.workflowResult = {
      status: workflow.status,
      executionId: run.meta?.executionId,
      workflowName: workflow.workflowName
    };
    extras.outputFormat = workflow.outputFormat || 'markdown';
  }

  // ── tool side channels ───────────────────────────────────────────────
  if (run.skills?.length) extras.activeSkills = run.skills;
  if (run.searchStatus !== null && run.searchStatus !== undefined) {
    extras.searchStatus = run.searchStatus;
  }
  const citations = mergeCitationEntries(run.citations);
  if (citations) extras.citations = citations;

  // ── completion metadata ──────────────────────────────────────────────
  if (finished) {
    if (run.knowledgeSources?.length) {
      extras.answerSource = { sources: run.knowledgeSources, type: 'mixed' };
    }
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

export default projectRunToMessage;
