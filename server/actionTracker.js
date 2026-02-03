import { EventEmitter } from 'events';
import { UnifiedEvents } from '../shared/unifiedEventSchema.js';
import logger from './utils/logger.js';

export class ActionTracker extends EventEmitter {
  constructor() {
    super();
    this.steps = 0;
  }

  trackAction(chatId, action = {}) {
    this.steps += 1;
    this.emit('fire-sse', { event: 'action', steps: this.steps, chatId, ...action });
  }

  trackError(chatId, error = {}) {
    const stacktrace = new Error().stack;
    logger.error(`Error for chat ID ${chatId}:`, { ...error, stacktrace });
    this.emit('fire-sse', { event: 'error', chatId, ...error });
  }

  trackConnected(chatId) {
    this.emit('fire-sse', { event: 'connected', chatId });
  }

  trackDisconnected(chatId, reason = {}) {
    this.emit('fire-sse', { event: 'disconnected', chatId, ...reason });
  }

  trackDone(chatId, finishReason = {}) {
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
}

export const actionTracker = new ActionTracker();
