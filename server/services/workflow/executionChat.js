/**
 * "Chat with Results": a stored chat that opens with a finished workflow
 * execution's question and answer, so the user can ask follow-up questions
 * about it.
 *
 * The chat used to be seeded in the browser (sessionStorage). A server-backed
 * chat never reads that copy — the store owns its transcript — so with durable
 * chats the results were lost on the way and the user landed in an empty chat.
 * The chat is created here instead, and its answer is the execution's own
 * output read from its state, never text a client posts: the stored transcript
 * is what a follow-up question is answered from, and it names the execution
 * it came from.
 *
 * @module services/workflow/executionChat
 */
import { randomUUID } from 'crypto';
import { newRunId } from '../loop/RunLog.js';
import { materializeAssistantTurn, materializeUserTurn } from '../chat/chatMaterializer.js';
import { getLocalizedString } from '../../utils/localize.js';

/** State fields that are engine bookkeeping, never a result (client: `filterInternalFields.js`). */
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

/** Execution statuses whose state holds the workflow's result. */
const FINISHED_STATUSES = new Set(['completed', 'approved']);

/** Longest question stored for the chat's opening turn. */
const MAX_INPUT_CHARS = 20_000;

function displayableOutput(data) {
  const output = {};
  for (const [key, value] of Object.entries(data || {})) {
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

/**
 * The opening exchange of a chat about an execution: what it was asked (its
 * text start inputs) and what it answered (the workflow's declared primary
 * output, else its longest text result, else all of its results as JSON).
 *
 * @param {Object} state - Workflow execution state (`WorkflowEngine.getState`).
 * @returns {{ userInput: string, outputText: string, workflow: Object|null,
 *   outputFormat: string }}
 */
export function executionHandoff(state) {
  const data = state?.data || {};
  const workflow = data._workflowDefinition || null;

  let outputText = '';
  const primaryOutputKey = workflow?.chatIntegration?.primaryOutput;
  // A dotted path (`_report.markdown`) names a nested field, as it does for
  // the answer of an `@workflow` run (`tools/workflowRunner.js`).
  const primaryValue =
    typeof primaryOutputKey === 'string' && primaryOutputKey
      ? primaryOutputKey.split('.').reduce((value, key) => value?.[key], data)
      : undefined;
  if (
    primaryValue !== undefined &&
    primaryValue !== null &&
    (typeof primaryValue !== 'string' || primaryValue.length > 0)
  ) {
    outputText =
      typeof primaryValue === 'object'
        ? JSON.stringify(primaryValue, null, 2)
        : String(primaryValue);
  } else {
    const output = displayableOutput(data);
    for (const value of Object.values(output)) {
      if (typeof value === 'string' && value.length > outputText.length) outputText = value;
    }
    if (!outputText && Object.keys(output).length > 0) {
      outputText = JSON.stringify(output, null, 2);
    }
  }

  const startNode = (workflow?.nodes || []).find(node => node.type === 'start');
  const inputVariables = startNode?.config?.inputVariables || [];
  const userInput = inputVariables
    .map(variable => data[variable.name])
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n\n')
    .slice(0, MAX_INPUT_CHARS);

  return {
    userInput,
    outputText,
    workflow,
    outputFormat: workflow?.chatIntegration?.outputFormat || 'markdown'
  };
}

/** Longest opening question a client may supply when the execution had no text input. */
const MAX_CONTEXT_MESSAGE_CHARS = 2000;

/**
 * Create the stored chat about an execution: its question, and the
 * execution's output as the answer, which carries the workflow result so the
 * reopened answer names — and links — the execution it came from.
 *
 * The caller has checked that the user may read the execution and use the
 * app, and that durable chats are on for them.
 *
 * @param {Object} params
 * @param {import('../chat/ChatRepository.js').default} params.repository
 * @param {Object} params.state - Execution state.
 * @param {string} params.executionId
 * @param {string} params.appId - App the chat is opened in.
 * @param {string} params.ownerId - Principal that owns the chat.
 * @param {string} params.identityMode - Identity mode `ownerId` was resolved in.
 * @param {string} [params.language] - For the workflow's name.
 * @param {unknown} [params.contextMessage] - The opening question when the execution had
 *   no text input (the client's translated "Here are the results …").
 * @returns {Promise<{chatId: string}|{error: 'NOT_FINISHED'|'NO_RESULTS'|'NOT_STORED'}>}
 */
export async function createExecutionChat({
  repository,
  state,
  executionId,
  appId,
  ownerId,
  identityMode,
  language = 'en',
  contextMessage
}) {
  // What a running or paused execution holds is not its result yet: a chat
  // opened on it would present a partial answer as the final one.
  if (!FINISHED_STATUSES.has(state?.status)) return { error: 'NOT_FINISHED' };
  const { userInput, outputText, workflow, outputFormat } = executionHandoff(state);
  if (!outputText) return { error: 'NO_RESULTS' };

  const workflowName = getLocalizedString(workflow?.name, language) || state?.workflowId || '';
  const opening =
    typeof contextMessage === 'string' ? contextMessage.slice(0, MAX_CONTEXT_MESSAGE_CHARS) : '';
  const chatId = `chat-${randomUUID()}`;
  // A turn of its own, not the execution's run: deleting the chat cascades to
  // its runs, and the execution has to outlive the chat.
  const runId = newRunId('chat');

  const question = await materializeUserTurn({
    repository,
    chatId,
    ownerId,
    identityMode,
    appId,
    runId,
    content: userInput || opening || workflowName,
    titleText: userInput ? null : workflowName,
    origin: { createdVia: 'workflow-execution', executionId }
  });
  if (!question) return { error: 'NOT_STORED' };

  const answer = await materializeAssistantTurn({
    repository,
    chatId,
    runId,
    summary: {
      status: 'success',
      content: outputText,
      finishReason: 'stop',
      activity: {
        workflowResult: { status: state.status, executionId, workflowName },
        outputFormat
      }
    },
    clientConnected: true
  });
  if (!answer) {
    // A chat holding the question without the results is not what was asked
    // for; take it away again rather than open it.
    await repository.deleteChat(chatId).catch(() => {});
    return { error: 'NOT_STORED' };
  }
  return { chatId };
}
