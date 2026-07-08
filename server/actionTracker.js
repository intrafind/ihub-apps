import { EventEmitter } from 'events';
import { UnifiedEvents } from '../shared/unifiedEventSchema.js';
import logger from './utils/logger.js';

export class ActionTracker extends EventEmitter {
  constructor() {
    super();
    this.stepCounts = new Map();
    // Every listener attached below (InMemorySink, agents/runs.js, workflowRoutes.js,
    // workflowRunner.js) is request/connection-scoped and pairs its on() with an off()
    // in a cleanup path, so concurrent chats/connections legitimately exceed the
    // default 10-listener warning threshold without leaking.
    this.setMaxListeners(0);
  }

  trackAction(chatId, action = {}) {
    const steps = (this.stepCounts.get(chatId) || 0) + 1;
    this.stepCounts.set(chatId, steps);
    this.emit('fire-sse', { event: 'action', steps, chatId, ...action });
  }

  trackError(chatId, error = {}) {
    const stacktrace = new Error().stack;
    logger.error(`Error for chat ID ${chatId}:`, { ...error, stacktrace });
    this.stepCounts.delete(chatId);
    this.emit('fire-sse', { event: 'error', chatId, ...error });
  }

  trackConnected(chatId) {
    this.emit('fire-sse', { event: 'connected', chatId });
  }

  trackDisconnected(chatId, reason = {}) {
    this.stepCounts.delete(chatId);
    this.emit('fire-sse', { event: 'disconnected', chatId, ...reason });
  }

  trackDone(chatId, finishReason = {}) {
    this.stepCounts.delete(chatId);
    this.emit('fire-sse', { event: UnifiedEvents.DONE, chatId, ...finishReason });
  }

  trackChunk(chatId, chunk = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.CHUNK, chatId, ...chunk });
  }

  trackSessionStart(chatId, details = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.SESSION_START, chatId, ...details });
  }

  trackSessionEnd(chatId, details = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.SESSION_END, chatId, ...details });
  }

  trackToolCallStart(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.TOOL_CALL_START, chatId, ...data });
  }

  trackToolCallProgress(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.TOOL_CALL_PROGRESS, chatId, ...data });
  }

  trackToolCallEnd(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.TOOL_CALL_END, chatId, ...data });
  }

  trackCitation(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.CITATION, chatId, ...data });
  }

  trackSafetyWarning(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.SAFETY_WARNING, chatId, ...data });
  }

  trackThinking(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.THINKING, chatId, ...data });
  }

  trackImage(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.IMAGE, chatId, ...data });
  }

  trackToolStreamComplete(chatId, data = {}) {
    this.emit('fire-sse', { event: 'tool-stream-complete', chatId, ...data });
  }

  /**
   * Track a clarification request from the ask_user tool
   * Emits a clarification event to the client with the question and input configuration
   * @param {string} chatId - The chat session ID
   * @param {Object} data - Clarification data including question, input_type, options, etc.
   */
  trackClarification(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.CLARIFICATION, chatId, ...data });
  }

  /**
   * Track a workflow step progress event on the chat's SSE channel
   * @param {string} chatId - The chat session ID (not the workflow executionId)
   * @param {Object} data - Step data: { nodeName, nodeType, status: 'running'|'completed'|'error', workflowName }
   */
  trackWorkflowStep(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.WORKFLOW_STEP, chatId, ...data });
  }

  /**
   * Track a workflow result event on the chat's SSE channel
   * @param {string} chatId - The chat session ID (not the workflow executionId)
   * @param {Object} data - Result data: { status: 'completed'|'failed', output, executionId, workflowName }
   */
  trackWorkflowResult(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.WORKFLOW_RESULT, chatId, ...data });
  }

  /**
   * Track a skill activation event on the chat's SSE channel
   * @param {string} chatId - The chat session ID
   * @param {Object} data - Skill data: { skillName, description }
   */
  trackSkillActivation(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.SKILL_ACTIVATION, chatId, ...data });
  }

  /**
   * Track answer source information on the chat's SSE channel
   * @param {string} chatId - The chat session ID
   * @param {Object} data - Source data: { sources: [], type: 'llm'|'mixed' }
   */
  trackAnswerSource(chatId, data = {}) {
    this.emit('fire-sse', { event: UnifiedEvents.ANSWER_SOURCE, chatId, ...data });
  }
}

export const actionTracker = new ActionTracker();
