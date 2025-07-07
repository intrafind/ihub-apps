import { EventEmitter } from 'events';

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
    console.error(`Error for chat ID ${chatId}:`, { ...error, stacktrace });
    this.emit('fire-sse', { event: 'error', chatId, ...error });
  }

  trackConnected(chatId) {
    this.emit('fire-sse', { event: 'connected', chatId });
  }

  trackDisconnected(chatId, reason = {}) {
    this.emit('fire-sse', { event: 'disconnected', chatId, ...reason });
  }

  trackDone(chatId, finishReason = {}) {
    this.emit('fire-sse', { event: 'done', chatId, ...finishReason });
  }

  trackChunk(chatId, chunk = {}) {
    this.emit('fire-sse', { event: 'chunk', chatId, ...chunk });
  }
}

export const actionTracker = new ActionTracker();
