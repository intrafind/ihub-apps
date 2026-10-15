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
 * The workflow's name as the caller reads it: in their language, else in
 * English, else the id they typed.
 *
 * @param {Object} workflow - Workflow definition (`name` is a string or a map of languages).
 * @param {string} language - Language the caller works in.
 * @param {string} fallback - What to call it when it has no usable name.
 * @returns {string}
 */
function workflowDisplayName(workflow, language, fallback) {
  const name = workflow.name;
  const localized = typeof name === 'object' ? name[language] || name.en : name;
  return localized || fallback;
}

/**
 * Why `@<workflow>` cannot be started from this chat, in words for the user.
 *
 * @param {Object} params
 * @param {Object} params.workflow - The mentioned workflow definition.
 * @param {string} params.workflowId - The id as typed in the message.
 * @param {{allowed: boolean, reason?: string}} params.access - See `mentionAccess`.
 * @param {string} params.clientLanguage - Language the caller works in.
 * @returns {string|null} The refusal, or null when the workflow can run.
 */
function refusalReason({ workflow, workflowId, access, clientLanguage }) {
  const isDisabled = workflow.enabled === false;
  const noChatIntegration = !workflow.chatIntegration?.enabled;
  const notInApp = access.reason === 'not_in_app';
  if (!isDisabled && !noChatIntegration && !notInApp) return null;

  const wfName = workflowDisplayName(workflow, clientLanguage, workflowId);
  if (isDisabled) return `Workflow "${wfName}" is disabled.`;
  if (noChatIntegration) {
    return `Workflow "${wfName}" is not configured for chat (chatIntegration.enabled is false).`;
  }
  return `Workflow "${wfName}" is not available in this app.`;
}

/**
 * Start the mentioned workflow as the answer to the chat's new message.
 *
 * @param {Object} params
 * @param {Object} params.workflow - The mentioned workflow definition.
 * @param {string} params.workflowId - The id as typed in the message.
 * @param {Object|undefined} params.app - The chat's app configuration.
 * @param {Object} params.newMessage - The new user message (host context, files).
 * @param {string} params.content - Its text, mention included.
 * @param {Array<Object>} params.conversation - See {@link tryHandleMentionWorkflow}.
 * @param {string} params.chatId - Chat id.
 * @param {string} params.appId - App the chat belongs to.
 * @param {string|null} [params.messageId] - The client's id for the new message.
 * @param {string} [params.modelId] - Model selected for the chat.
 * @param {Object} params.user - Authenticated caller.
 * @param {string} params.clientLanguage - Language the caller works in.
 * @param {Object|null} [params.persistence] - Durable-chat context, or null.
 * @returns {Promise<{handled: true, response: Object}>}
 */
async function launchMentionWorkflow({
  workflow,
  workflowId,
  app,
  newMessage,
  content,
  conversation,
  chatId,
  appId,
  messageId,
  modelId,
  user,
  clientLanguage,
  persistence
}) {
  logger.info('@mention workflow triggered', {
    component: COMPONENT,
    workflowId,
    chatId
  });

  // Strip the @mention from the input; the host item (email, page,
  // meeting) goes along as tagged blocks, the files as inputFiles.
  const withoutMention = content.replace(/@[\w.-]+/, '').trim();
  const strippedInput = renderUserMessage({
    content: withoutMention,
    hostContext: newMessage.hostContext
  });

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
    titleText: withoutMention || getLocalizedString(workflow.name, clientLanguage)
  });
  // Announced once the question is stored, like an ordinary turn
  // (`ChatService`): a client reloading its chat list on the first
  // frame finds the chat there.
  launch.emit(SSE_V2_EVENTS.RUN_STARTED, {
    kind: 'workflow',
    refs: { chatId, appId, messageId, workflowId }
  });

  try {
    const workflowRunnerMod = await import('../../tools/workflowRunner.js');

    // Fire-and-forget: start workflow but don't await completion.
    // The workflowRunner bridge streams step events and final output via SSE.
    workflowRunnerMod
      .default({
        workflowId,
        chatId,
        runId: workflowRunId,
        user,
        appConfig: app,
        _chatStored: Boolean(persistence),
        input: strippedInput,
        modelId,
        _chatHistory: chatHistory.length > 0 ? chatHistory : undefined,
        // The files (or the image) the last message carries.
        _fileData: newMessage.fileData || newMessage.imageData || undefined,
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

/**
 * The first `@workflow-name` in a message.
 *
 * @param {Object|undefined} message - A chat message.
 * @returns {{content: string, workflowId: string}|null} The text of the
 *   message and the id after its `@`, or null when it mentions nobody.
 */
function findMention(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  const match = content.match(/@([\w.-]+)/);
  return match ? { content, workflowId: match[1] } : null;
}

/**
 * Tell the caller why the mentioned workflow was not started: a 400 on the
 * POST when no stream is open to carry it, a failed run on the stream when one is.
 *
 * @param {Object} params
 * @param {string} params.chatId - Chat id.
 * @param {string|null} [params.messageId] - The client's id for the new message.
 * @param {string} params.workflowId - The id as typed in the message.
 * @param {string} params.reason - See {@link refusalReason}.
 * @returns {{handled: true, response: Object, statusCode?: number}}
 */
function refuseMention({ chatId, messageId, workflowId, reason }) {
  if (!hasChatClient(chatId)) {
    return { handled: true, statusCode: 400, response: { status: 'error', message: reason } };
  }
  emitFailedRun(chatId, {
    kind: 'workflow',
    messageId,
    code: 'WORKFLOW_UNAVAILABLE',
    message: reason,
    refs: { workflowId }
  });
  return { handled: true, response: { status: 'streaming', chatId } };
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
  const mention = findMention(lastUserMsg);
  if (!mention) return NOT_HANDLED;

  const mentionedId = mention.workflowId;
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

  // If the user explicitly @-mentioned a workflow but it is not
  // chat-runnable, refuse the message instead of falling through to
  // the LLM (which would happily pick a *different* registered
  // workflow tool — the @human → @auto switch users have seen).
  const reason = refusalReason({
    workflow: mentionedWorkflow,
    workflowId: mentionedId,
    access,
    clientLanguage
  });
  if (reason) return refuseMention({ chatId, messageId, workflowId: mentionedId, reason });

  // Awaited rather than returned bare, so a failure still has this frame in its async stack.
  return await launchMentionWorkflow({
    workflow: mentionedWorkflow,
    workflowId: mentionedId,
    app: mentionApp,
    newMessage: lastUserMsg,
    content: mention.content,
    conversation,
    chatId,
    appId,
    messageId,
    modelId,
    user,
    clientLanguage,
    persistence
  });
}
