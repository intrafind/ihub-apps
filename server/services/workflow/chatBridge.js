/**
 * Chat bridge for browser disconnect resilience.
 *
 * Two pieces of state that survive a single chat SSE drop:
 *  - pendingFinish: workflows that completed while the chat was disconnected.
 *    On reconnect we drain this so the chat bubble fills in (result + chunk +
 *    done) instead of silently dropping the answer.
 *
 *  - replayStateFromExecution: builds an event log from persisted state so a
 *    reconnecting client can catch up on steps it missed for a still-running
 *    workflow.
 *
 * Both are bounded:
 *  - pendingFinish entries expire after 10 minutes (the chat tab is either back
 *    by then or the user has moved on).
 *  - We only stash up to 200 pending finishes; the oldest are evicted first.
 */

import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { clients } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;

/** chatId → { payload, expiresAt } */
const pendingFinish = new Map();

function evictExpired() {
  const now = Date.now();
  for (const [chatId, entry] of pendingFinish) {
    if (entry.expiresAt <= now) pendingFinish.delete(chatId);
  }
}

/**
 * Stash a finished workflow's chat payload for a disconnected client.
 *
 * @param {string} chatId
 * @param {Object} payload - { workflowName, executionId, status, outputText, outputFormat, errorMsg, isCancelled }
 */
export function recordPendingFinish(chatId, payload) {
  if (!chatId) return;
  evictExpired();
  if (pendingFinish.size >= MAX_PENDING) {
    // Drop oldest
    const oldestKey = pendingFinish.keys().next().value;
    if (oldestKey !== undefined) pendingFinish.delete(oldestKey);
  }
  pendingFinish.set(chatId, { payload, expiresAt: Date.now() + PENDING_TTL_MS });
  logger.debug('Pending workflow finish stashed for disconnected chat', {
    component: 'ChatBridge',
    chatId,
    executionId: payload.executionId
  });
}

/**
 * Pop and return a pending finish payload for the given chatId, if any.
 *
 * @param {string} chatId
 * @returns {Object|null}
 */
export function drainPendingFinish(chatId) {
  if (!chatId) return null;
  evictExpired();
  const entry = pendingFinish.get(chatId);
  if (!entry) return null;
  pendingFinish.delete(chatId);
  return entry.payload;
}

/**
 * Build a sequence of replay events from persisted state so the chat catches
 * up on steps it missed for a still-running workflow.
 *
 * Returns events the caller can feed to `actionTracker.trackWorkflowStep(...)`
 * — already shaped as the same fields the live runner uses.
 *
 * @param {Object} state - The workflow state object from StateManager.get()
 * @param {Object} workflow - The workflow definition (for node name/type lookup)
 * @param {string} language
 * @returns {Array<{nodeName: string, nodeType: string, status: string, executionId: string, chatVisible: boolean}>}
 */
export function buildReplayStepsFromState(state, workflow, language = 'en') {
  if (!state || !workflow) return [];

  const nodes = workflow.nodes || [];
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  const localize = value => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object')
      return value[language] || value.en || Object.values(value)[0] || '';
    return String(value);
  };

  const events = [];

  // Replay completed nodes in the order they appear in state.completedNodes
  for (const nodeId of state.completedNodes || []) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    if (node.config?.chatVisible === false) continue;
    events.push({
      nodeName: localize(node.name) || nodeId,
      nodeType: node.type || 'unknown',
      status: 'completed',
      executionId: state.executionId,
      chatVisible: true
    });
  }

  // Replay currently-running nodes
  for (const nodeId of state.currentNodes || []) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    if (node.config?.chatVisible === false) continue;
    events.push({
      nodeName: localize(node.name) || nodeId,
      nodeType: node.type || 'unknown',
      status: 'running',
      executionId: state.executionId,
      chatVisible: true
    });
  }

  return events;
}

/**
 * Detect an `@workflow-name` mention in the last user message and, if it
 * resolves to a chat-runnable workflow, dispatch it (fire-and-forget — the
 * workflow streams its own progress/result over the chat's SSE channel).
 *
 * Returns `{ handled: true, response, statusCode? }` if the mention path
 * fully handled the request (rejection or dispatch), or `{ handled: false }`
 * to let the caller fall through to normal chat processing.
 *
 * @param {Object} params
 * @param {Array}  params.messages - Full chat message history for this request.
 * @param {string} params.chatId
 * @param {string} params.modelId
 * @param {Object} params.user
 * @param {string} params.clientLanguage
 */
export async function tryHandleMentionWorkflow({
  messages,
  chatId,
  modelId,
  user,
  clientLanguage
}) {
  const lastUserMsg = messages[messages.length - 1];
  const lastUserContent = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
  const mentionMatch = lastUserContent.match(/@([\w.-]+)/);
  if (!mentionMatch) return { handled: false };

  const mentionedId = mentionMatch[1];
  const mentionedWorkflow = configCache.getWorkflowById(mentionedId);
  if (!mentionedWorkflow) return { handled: false };

  const isDisabled = mentionedWorkflow.enabled === false;
  const noChatIntegration = !mentionedWorkflow.chatIntegration?.enabled;

  // If the user explicitly @-mentioned a workflow but it is not
  // chat-runnable, refuse the message instead of falling through to
  // the LLM (which would happily pick a *different* registered
  // workflow tool — the @human → @auto switch users have seen).
  if (isDisabled || noChatIntegration) {
    const wfName =
      (typeof mentionedWorkflow.name === 'object'
        ? mentionedWorkflow.name[clientLanguage] || mentionedWorkflow.name.en
        : mentionedWorkflow.name) || mentionedId;
    const reason = isDisabled
      ? `Workflow "${wfName}" is disabled.`
      : `Workflow "${wfName}" is not configured for chat (chatIntegration.enabled is false).`;
    actionTracker.trackError(chatId, { message: reason });
    if (!clients.has(chatId)) {
      return { handled: true, statusCode: 400, response: { status: 'error', message: reason } };
    }
    actionTracker.trackChunk(chatId, { content: reason });
    actionTracker.trackDone(chatId, { finishReason: 'error' });
    return { handled: true, response: { status: 'streaming', chatId } };
  }

  logger.info('@mention workflow triggered', {
    component: 'ChatBridge',
    workflowId: mentionedId,
    chatId
  });

  // Strip the @mention from the input
  const strippedInput = lastUserContent.replace(/@[\w.-]+/, '').trim();

  // Collect file data from the last message
  const fileData = lastUserMsg.fileData || null;
  const imageData = lastUserMsg.imageData || null;

  // Build chat history from all prior messages (excluding the last)
  const chatHistory = messages.slice(0, -1).map(m => ({
    role: m.role,
    content: m.content
  }));

  try {
    const workflowRunnerMod = await import('../../tools/workflowRunner.js');

    // Fire-and-forget: start workflow but don't await completion.
    // The workflowRunner bridge streams step events and final output via SSE.
    workflowRunnerMod
      .default({
        workflowId: mentionedId,
        chatId,
        user,
        input: strippedInput,
        modelId,
        _chatHistory: chatHistory.length > 0 ? chatHistory : undefined,
        _fileData: fileData || imageData || undefined,
        language: clientLanguage
      })
      .catch(error => {
        logger.error('Error running @mention workflow', {
          component: 'ChatBridge',
          error
        });
        actionTracker.trackError(chatId, {
          message: `Workflow execution failed: ${error.message}`
        });
      });

    // Return immediately — the SSE channel delivers all progress + final output
    return { handled: true, response: { status: 'streaming', chatId } };
  } catch (error) {
    logger.error('Error loading workflow runner', { component: 'ChatBridge', error });
    actionTracker.trackError(chatId, {
      message: `Workflow execution failed: ${error.message}`
    });
    return { handled: true, response: { status: 'error', message: error.message } };
  }
}
