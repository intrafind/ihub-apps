/**
 * Shared SSE emit helper.
 *
 * Both the agent tool implementations and the artifact store emit
 * `actionTracker.emit('fire-sse', …)` events with identical try/catch
 * wrappers. This helper consolidates that pattern so the swallowed-error
 * log message is consistent and we don't repeat the boilerplate in every
 * call site.
 *
 *   import { createSseEmitter } from '../utils/sseEmitter.js';
 *   const emit = createSseEmitter('AgentTools');
 *   emit('agent.memory.read', { profileId, version }, chatId);
 *
 * Failures inside the listener chain are best-effort: SSE delivery is not
 * critical to the agent semantics (state persistence is the source of
 * truth), so we log and continue rather than letting an event-listener
 * exception bubble back into the calling tool.
 */

import { actionTracker } from '../actionTracker.js';
import logger from './logger.js';

export function createSseEmitter(component) {
  return function emit(event, payload, chatId) {
    try {
      actionTracker.emit('fire-sse', { event, chatId, ...payload });
    } catch (err) {
      logger.warn(`${component} event emit failed`, {
        component,
        event,
        error: err.message
      });
    }
  };
}

export default createSseEmitter;
