// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pure projection of one SSE v2 RunState (shared/run/runReducer.js) onto the
 * assistant chat message that `ChatMessage.jsx` renders.
 *
 *   projectRunToMessage(run) → { content, loading, extras }
 *
 * `extras` carries exactly the message fields the chat UI reads today:
 * thoughts, images, clarification/awaitingInput/clarificationAnswered,
 * workflowCheckpoint, workflowSteps/workflowStep, workflowResult/outputFormat,
 * activeSkills, searchStatus, searchSummary, toolActivity, mcpApps, integrationAuthRequired, sources,
 * answerSource, finishReason. The hook (`useAppChat`) only decides WHEN to write the
 * projection and which message it belongs to — it never interprets events.
 *
 * @module features/chat/runToMessage
 */
import { isRunFinished, getInteractions } from '../../../../shared/run/runReducer.js';
import { buildToolActivity } from '../../../../shared/run/toolActivity.js';
import {
  answerSourceOf,
  buildWorkflowSteps,
  settleWorkflowSteps,
  workflowResultOf
} from '../../../../shared/run/runActivity.js';
import { insertSupportMarkers } from '../../../../shared/sources/index.js';
import { generatedFilesOf } from '../../../../shared/generatedFiles.js';
import { buildMcpAppViews } from './mcpApps/mcpAppViewList';
import { buildAuthPrompts } from '../integrations/connect/authPrompts';
import {
  interactionToCheckpoint,
  isCheckpointInteraction,
  isClarificationInteraction,
  isToolApprovalInteraction
} from '../../shared/run/interactionToCheckpoint';

/**
 * Build the `toolApproval` message field from a chat tool approval (#2945):
 * what `ApprovalCard` shows. The arguments are data to display, never markup.
 *
 * @param {Object} interaction - interaction of kind `approval` raised by a chat turn
 * @returns {Object} `{ interactionId, status, toolId, toolName, integration, sideEffect,
 *   dataFlow, args, justification, expiresAt }`
 */
export function buildToolApproval(interaction) {
  const display = interaction.prompt?.displayData || {};
  return {
    interactionId: interaction.id,
    status: interaction.status || 'pending',
    toolId: display.toolId || interaction.source?.toolId || '',
    toolName: display.toolName || display.toolId || interaction.source?.toolId || '',
    integration: display.integration || null,
    sideEffect: display.sideEffect || 'unknown',
    sideEffectSource: display.sideEffectSource || null,
    dataFlow: display.dataFlow || 'internal',
    args: display.args && typeof display.args === 'object' ? display.args : {},
    justification: typeof display.justification === 'string' ? display.justification : '',
    expiresAt: interaction.policy?.expiresAt || null
  };
}

/** Fallback when a stream/error frame carries no message (callers pass the translated string). */
export const DEFAULT_STREAM_ERROR_MESSAGE = 'An error occurred during streaming';

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

/** The answer text with the run's sources and, for a failed run, its error appended. */
function contentOf(run, extras, fallbackErrorMessage) {
  // Everything the run found (`sources/added`, folded by the reducer). Google's
  // answer text carries no links: its grounding supports say which passage
  // each source backs, and the markers go there — the stored answer gets the
  // same (chatMaterializer.js).
  const sources = run.sources;
  let content = run.text || '';
  if (sources?.supports?.length) content = insertSupportMarkers(content, sources.supports);
  if (sources?.items?.length || sources?.queries?.length) extras.sources = sources;
  if (run.error) {
    // A failed run: the error text is appended to whatever streamed.
    content = `${content}\n\n${run.error.message || fallbackErrorMessage}`;
  }
  return content;
}

/** The clarification (ask_user) card. @returns {boolean} Whether the run waits for the answer. */
function addClarification(extras, interactions) {
  const question = last(interactions, isClarificationInteraction);
  if (!question) return false;
  extras.clarification = buildClarification(question);
  // A question still open when the turn ended (status paused) waits just the same.
  if (question.status === 'pending') {
    extras.awaitingInput = true;
    return true;
  }
  extras.awaitingInput = false;
  extras.clarificationAnswered = true;
  return false;
}

/**
 * Tool approval (#2945). A pending approval hands control back to the user like a
 * question: the card waits for Approve / Reject, which the next message carries.
 * @returns {boolean} Whether the run waits for the decision.
 */
function addToolApproval(extras, interactions) {
  const approval = last(interactions, isToolApprovalInteraction);
  if (!approval) return false;
  extras.toolApproval = buildToolApproval(approval);
  if (approval.status !== 'pending') return false;
  extras.awaitingInput = true;
  return true;
}

/** Chat-launched workflow: checkpoint, steps, result. */
function addWorkflowState(extras, run, interactions, finished) {
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
}

/** What the turn's tools reported beside their answers. */
function addToolSideChannels(extras, run) {
  if (run.skills?.length) extras.activeSkills = run.skills;
  // Which projects the turn reached and how (`knowledge/scope`): the badge
  // of the answer, streamed and stored alike.
  if (run.knowledgeScope?.projects?.length) extras.knowledgeScope = run.knowledgeScope;
  // How full the context window is, as the server counts it — tool results included.
  if (run.context) extras.context = run.context;
  if (run.searchStatus !== null && run.searchStatus !== undefined) {
    extras.searchStatus = run.searchStatus;
  }
  // Outlives the streaming phase on purpose: what the turn searched for and
  // how much it found is part of the answer's provenance, not a progress
  // spinner, so the finished message keeps showing it.
  if (run.searchSummary) extras.searchSummary = run.searchSummary;
  // The searches the turn ran, the pages they found and read, and the other
  // tools it called. Like the search summary, it stays with the finished
  // answer as provenance.
  const toolActivity = buildToolActivity(run);
  // Said outright when there is none: a message keeps the fields a projection
  // leaves out, and the activity of a live turn can go away again (the idle
  // line "Waiting for the model…" ends before any row exists).
  extras.toolActivity = toolActivity ?? undefined;
  // Interactive MCP App views the turn's tools rendered.
  const mcpApps = buildMcpAppViews(run);
  if (mcpApps) extras.mcpApps = mcpApps;
  // MCP servers with per-user sign-in the user has to connect (one per server).
  const integrationAuthRequired = buildAuthPrompts(run);
  if (integrationAuthRequired) extras.integrationAuthRequired = integrationAuthRequired;
  // Scheduled tasks a scheduling tool proposed: confirmation cards.
  const scheduledTaskProposals = (run.tools || [])
    .map(tool => tool.scheduledTaskProposal)
    .filter(proposal => proposal && typeof proposal.proposalId === 'string');
  if (scheduledTaskProposals.length) extras.scheduledTaskProposals = scheduledTaskProposals;
  // Files the turn's tools generated (a PDF from `create_pdf`): download cards.
  const generatedFiles = generatedFilesOf((run.tools || []).flatMap(tool => tool.files || []));
  if (generatedFiles.length) extras.generatedFiles = generatedFiles;
}

function addCompletionMetadata(extras, run, finished) {
  if (finished) {
    const answerSource = answerSourceOf(run);
    if (answerSource) extras.answerSource = answerSource;
    // The server's provenance object: the "AI generated" details under the answer.
    if (run.provenance) extras.provenance = run.provenance;
    if (run.finishReason !== null && run.finishReason !== undefined) {
      extras.finishReason = run.finishReason;
    }
  }
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

  const content = contentOf(run, extras, fallbackErrorMessage);

  // ── reasoning / media ────────────────────────────────────────────────
  if (run.thinking?.length) extras.thoughts = run.thinking;
  if (run.images?.length) extras.images = run.images;

  const awaitingQuestion = addClarification(extras, interactions);
  const awaitingApproval = addToolApproval(extras, interactions);
  addWorkflowState(extras, run, interactions, finished);
  addToolSideChannels(extras, run);
  addCompletionMetadata(extras, run, finished);

  // ── loading ──────────────────────────────────────────────────────────
  // Streaming while the run is running; a workflow checkpoint pause keeps the
  // spinner (the turn continues once the checkpoint is answered) while a
  // clarification pause hands control back to the user.
  const loading =
    !run.error &&
    (run.status === 'running' ||
      (run.status === 'paused' && !awaitingQuestion && !awaitingApproval));

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
