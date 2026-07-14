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
 * Non-destructive check for whether a pending finish is stashed for chatId.
 * Used to decide whether the workflow-specific reconnect replay owns this
 * chat (vs. the generic resumable-stream buffer) without draining it.
 *
 * @param {string} chatId
 * @returns {boolean}
 */
export function hasPendingFinish(chatId) {
  if (!chatId) return false;
  evictExpired();
  return pendingFinish.has(chatId);
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
