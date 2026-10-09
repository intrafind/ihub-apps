/**
 * `@workflow-name` mentions in a chat message.
 *
 * Starting a workflow from the chat composer is a chat turn that never goes
 * through `ChatService`: this module detects the mention, enforces who may run
 * the workflow, launches it fire-and-forget and — for a stored chat — writes
 * both halves of the exchange, so the route handler
 * (`routes/chat/sessionRoutes.js`) only has to relay the outcome.
 *
 * @module services/workflow/mentionWorkflow
 */
import configCache from '../../configCache.js';
import { hasChatClient } from '../../sse.js';
import { RunStreamEmitter } from '../loop/RunStream.js';
import { newRunId } from '../loop/RunLog.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { renderUserMessage } from '../../../shared/promptContext.js';
import { materializeAssistantTurn, materializeUserTurn } from '../chat/chatMaterializer.js';
import { recordRunActivity } from '../chat/runActivity.js';
import { emitFailedRun } from '../chat/failedRun.js';
import { mentionAccess } from './workflowAccess.js';
import { getLocalizedString } from '../../utils/localize.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'mentionWorkflow';

const NOT_HANDLED = Object.freeze({ handled: false });

/**
 * The outcome a workflow run resolved with, in the shape the materializer's
 * `summary` describes. A cancelled workflow is an abort, anything that is not
 * a completion is a failure, and the answer text is the one the run streamed.
 *
 * @param {Object} result - What `workflowRunner` resolved with.
 * @returns {Object}
 */
export function workflowSummary(result) {
  const content = typeof result?.outputText === 'string' ? result.outputText : '';
  if (result?.status === 'completed') return { status: 'success', content, finishReason: 'stop' };
  if (result?.status === 'cancelled') {
    return { status: 'aborted', content, finishReason: 'cancelled' };
  }
  return {
    status: 'error',
    content,
    finishReason: 'error',
    errorInfo: {
      code: 'WORKFLOW_FAILED',
      message: String(result?.error || 'Workflow execution failed')
    }
  };
}

/**
 * Write the human half of an @mention workflow turn, or nothing when the chat
 * is not persisted.
 *
 * @param {Object} params
 * @param {Object|null} params.persistence - Durable-chat context, or null.
 * @param {string} params.chatId - Chat id.
 * @param {string} params.appId - App the chat belongs to.
 * @param {string} [params.modelId] - Model the chat last used.
 * @param {string} params.runId - The workflow's run id.
 * @param {string} [params.titleText] - What a chat this turn opens is named
 *   after: the message without the mention.
 * @returns {Promise<void>}
 */
async function materializeWorkflowUserTurn({
  persistence,
  chatId,
  appId,
  modelId,
  runId,
  titleText
}) {
  if (!persistence) return;
  await materializeUserTurn({
    titleText,
    settings: persistence.settings,
    variables: persistence.variables,
    repository: persistence.repository,
    chatId,
    ownerId: persistence.ownerId,
    identityMode: persistence.identityMode,
    appId,
    modelId,
    runId,
    content: persistence.content,
    clientMessageId: persistence.clientMessageId,
    attachments: persistence.attachments,
    replaceFromMessageId: persistence.replaceFromMessageId
  });
}

/**
 * Write the assistant half of an @mention workflow turn and release the chat,
 * or nothing when the chat is not persisted.
 *
 * @param {Object} params
 * @param {Object|null} params.persistence - Durable-chat context, or null.
 * @param {string} params.chatId - Chat id.
 * @param {string} params.runId - The workflow's run id.
 * @param {Object} params.summary - Turn outcome; see {@link workflowSummary}.
 * @returns {Promise<void>}
 */
async function materializeWorkflowAssistantTurn({ persistence, chatId, runId, summary }) {
  if (!persistence) return;
  await materializeAssistantTurn({
    repository: persistence.repository,
    chatId,
    runId,
    summary,
    clientConnected: hasChatClient(chatId)
  });
}

/**
 * Detect an `@workflow-name` mention in the last user message and, when it
 * names a workflow the caller may run from this chat, launch it.
 *
 * The launch is fire-and-forget: the workflow streams its progress and answer
 * over the chat's SSE channel under its own run, so the response only
 * acknowledges the start. A mention of a workflow that cannot be run from the
 * chat is refused rather than passed on to the model, which would happily pick
 * a *different* registered workflow tool.
 *
 * @param {Object} params
 * @param {Array<Object>} params.messages - The messages as posted; the last one
 *   carries the mention, its host context and its files.
 * @param {Array<Object>} params.conversation - The turns the workflow sees as
 *   chat history, last one being the new message. For a stored chat the prior
 *   turns came out of the store, not off the wire, so this is not `messages`.
 * @param {string} params.chatId - Chat id.
 * @param {string} params.appId - App the chat belongs to.
 * @param {string|null} [params.messageId] - The client's id for the new message.
 * @param {string} [params.modelId] - Model selected for the chat.
 * @param {Object} params.user - Authenticated caller (`req.user`).
 * @param {string} params.clientLanguage - Language the caller works in.
 * @param {Object|null} [params.persistence] - Durable-chat context, or null.
 * @returns {Promise<{handled: false}|{handled: true, response: Object, statusCode?: number}>}
 *   `handled: false` leaves the message to the normal chat path; otherwise
 *   `response` is the JSON body to answer with, under `statusCode` when set.
 */
export async function tryHandleMentionWorkflow({
  messages,
  conversation,
  chatId,
  appId,
  messageId,
  modelId,
  user,
  clientLanguage,
  persistence
}) {
  const lastUserMsg = messages.at(-1);
  const lastUserContent = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
  const mentionMatch = lastUserContent.match(/@([\w.-]+)/);
  if (!mentionMatch) return NOT_HANDLED;

  const mentionedId = mentionMatch[1];
  const mentionedWorkflow = configCache.getWorkflowById(mentionedId);
  if (!mentionedWorkflow) return NOT_HANDLED;

  // The composer only offers the workflows the app lists and the viewer's
  // groups grant; the mention is plain text, so the same rule is enforced
  // here. A workflow the caller may not run is not one to them at all: the
  // mention stays ordinary text, as for an id that names nothing, rather than
  // confirming that the workflow exists.
  const mentionApp = (configCache.getApps().data || []).find(a => a.id === appId);
  const access = mentionAccess({ user, app: mentionApp, workflow: mentionedWorkflow });
  if (access.reason === 'not_permitted') return NOT_HANDLED;

  const isDisabled = mentionedWorkflow.enabled === false;
  const noChatIntegration = !mentionedWorkflow.chatIntegration?.enabled;
  const notInApp = access.reason === 'not_in_app';

  // If the user explicitly @-mentioned a workflow but it is not
  // chat-runnable, refuse the message instead of falling through to
  // the LLM (which would happily pick a *different* registered
  // workflow tool — the @human → @auto switch users have seen).
  if (isDisabled || noChatIntegration || notInApp) {
    const wfName =
      (typeof mentionedWorkflow.name === 'object'
        ? mentionedWorkflow.name[clientLanguage] || mentionedWorkflow.name.en
        : mentionedWorkflow.name) || mentionedId;
    const reason = isDisabled
      ? `Workflow "${wfName}" is disabled.`
      : noChatIntegration
        ? `Workflow "${wfName}" is not configured for chat (chatIntegration.enabled is false).`
        : `Workflow "${wfName}" is not available in this app.`;
    if (!hasChatClient(chatId)) {
      return { handled: true, statusCode: 400, response: { status: 'error', message: reason } };
    }
    emitFailedRun(chatId, {
      kind: 'workflow',
      messageId,
      code: 'WORKFLOW_UNAVAILABLE',
      message: reason,
      refs: { workflowId: mentionedId }
    });
    return { handled: true, response: { status: 'streaming', chatId } };
  }

  logger.info('@mention workflow triggered', {
    component: COMPONENT,
    workflowId: mentionedId,
    chatId
  });

  // Strip the @mention from the input; the host item (email, page,
  // meeting) goes along as tagged blocks, the files as inputFiles.
  const withoutMention = lastUserContent.replace(/@[\w.-]+/, '').trim();
  const strippedInput = renderUserMessage({
    content: withoutMention,
    hostContext: lastUserMsg.hostContext
  });

  // Collect file data from the last message
  const fileData = lastUserMsg.fileData || null;
  const imageData = lastUserMsg.imageData || null;

  // Build chat history from all prior messages (excluding the last).
  // From `conversation`, not the request body: for a persisted chat
  // the prior turns came out of the store, not off the wire.
  const chatHistory = conversation.slice(0, -1).map(m => ({
    role: m.role,
    content: m.content
  }));

  // The @mention launch owns a run on the chat stream: the bridge in
  // workflowRunner streams progress and the answer under this runId.
  const workflowRunId = newRunId('workflow');
  // The steps it goes through are stored with its answer.
  if (persistence) recordRunActivity(workflowRunId);
  const launch = new RunStreamEmitter({ streamId: chatId, runId: workflowRunId });
  const failLaunch = message => {
    launch.emit(SSE_V2_EVENTS.STREAM_ERROR, { code: 'WORKFLOW_FAILED', message });
    launch.emit(SSE_V2_EVENTS.RUN_ENDED, {
      status: 'error',
      finishReason: 'error',
      error: { message }
    });
  };

  // A workflow turn is a turn: the user asked something in this chat
  // and read an answer in it. The launch never goes through
  // `ChatService`, which is what materializes an ordinary turn, so
  // both halves are written here or the exchange is missing from the
  // transcript — and from the history every later turn replays.
  await materializeWorkflowUserTurn({
    persistence,
    chatId,
    appId,
    modelId,
    runId: workflowRunId,
    // Named after what was asked, not after the id that was typed;
    // a bare `@workflow` is named after the workflow.
    titleText: withoutMention || getLocalizedString(mentionedWorkflow.name, clientLanguage)
  });
  // Announced once the question is stored, like an ordinary turn
  // (`ChatService`): a client reloading its chat list on the first
  // frame finds the chat there.
  launch.emit(SSE_V2_EVENTS.RUN_STARTED, {
    kind: 'workflow',
    refs: { chatId, appId, messageId, workflowId: mentionedId }
  });

  try {
    const workflowRunnerMod = await import('../../tools/workflowRunner.js');

    // Fire-and-forget: start workflow but don't await completion.
    // The workflowRunner bridge streams step events and final output via SSE.
    workflowRunnerMod
      .default({
        workflowId: mentionedId,
        chatId,
        runId: workflowRunId,
        user,
        appConfig: mentionApp,
        _chatStored: Boolean(persistence),
        input: strippedInput,
        modelId,
        _chatHistory: chatHistory.length > 0 ? chatHistory : undefined,
        _fileData: fileData || imageData || undefined,
        language: clientLanguage
      })
      .then(result => {
        // A workflow that could not start never announced an end of
        // the run it was given: end it here, or the chat's
        // placeholder spins until the page is reloaded.
        if (result?.status === 'error') {
          failLaunch(result.error || 'Workflow execution failed');
        }
        // The assistant half comes off the resolved run rather than
        // the SSE frames: the client may be long gone by now, and
        // the store is the thing that has to outlive it.
        return materializeWorkflowAssistantTurn({
          persistence,
          chatId,
          runId: workflowRunId,
          summary: workflowSummary(result)
        });
      })
      .catch(error => {
        logger.error('Error running @mention workflow', { component: COMPONENT, error });
        failLaunch(`Workflow execution failed: ${error.message}`);
        return materializeWorkflowAssistantTurn({
          persistence,
          chatId,
          runId: workflowRunId,
          summary: workflowSummary({ status: 'failed', error: error.message })
        });
      });

    // Return immediately — the SSE channel delivers all progress + final output
    return { handled: true, response: { status: 'streaming', chatId } };
  } catch (error) {
    logger.error('Error loading workflow runner', { component: COMPONENT, error });
    failLaunch(`Workflow execution failed: ${error.message}`);
    // The user half is already stored and the chat is marked
    // `running` for a run that will never start; close it out.
    await materializeWorkflowAssistantTurn({
      persistence,
      chatId,
      runId: workflowRunId,
      summary: workflowSummary({ status: 'failed', error: error.message })
    });
    return { handled: true, response: { status: 'error', message: error.message } };
  }
}
