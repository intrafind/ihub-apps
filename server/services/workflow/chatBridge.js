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
 *
 * In cluster mode the stash is mirrored to every worker. The workflow finishes
 * on whichever worker ran it, but the browser's reconnect can land anywhere, so
 * a worker-local stash would leave the answer sitting in a process the
 * reconnecting client never reaches. Entries are small, capped and short-lived,
 * so replicating them is cheaper than routing a lookup.
 */

import logger from '../../utils/logger.js';
import { publish, subscribe } from '../../clusterBus.js';
import { getLocalizedString } from '../../utils/localize.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;

const RECORD_CHANNEL = 'workflow:pending-finish';
const DRAIN_CHANNEL = 'workflow:pending-drain';

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
  stashPendingFinish(chatId, payload);
  publish(RECORD_CHANNEL, { chatId, payload });
}

/**
 * Insert into the local stash without announcing it. Used both by
 * `recordPendingFinish` and by the bus subscriber applying another worker's
 * record, which must not re-publish.
 */
function stashPendingFinish(chatId, payload) {
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
  // Every worker holds a copy; tell the others this one has been consumed so a
  // later reconnect elsewhere cannot deliver the same finish a second time.
  publish(DRAIN_CHANNEL, { chatId });
  return entry.payload;
}

subscribe(RECORD_CHANNEL, ({ chatId, payload }) => {
  if (!chatId) return;
  stashPendingFinish(chatId, payload);
});

subscribe(DRAIN_CHANNEL, ({ chatId }) => {
  pendingFinish.delete(chatId);
});

/**
 * Build a sequence of replay events from persisted state so the chat catches
 * up on steps it missed for a still-running workflow.
 *
 * Returns step events the caller projects onto `progress/node` frames
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
    if (typeof value === 'object') return getLocalizedString(value, language);
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
