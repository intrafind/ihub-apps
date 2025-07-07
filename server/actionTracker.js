import { EventEmitter } from 'events';

/**
 * Central tracker to emit progress and action events.
 * Tools and server components can update the current step
 * via `trackAction` or `trackThink`.
 */
export class ActionTracker extends EventEmitter {
  constructor() {
    super();
    this.state = {
      thisStep: { action: 'start', message: '', references: [], think: '' },
      gaps: [],
      totalStep: 0
    };
  }

  /**
   * Merge new state data and emit an action event.
   * @param {Partial<object>} newState
   */
  trackAction(newState = {}) {
    this.state = { ...this.state, ...newState };
    this.state.totalStep += 1;
    this.emit('fire-sse', { event: 'action', data: this.state.thisStep });
  }

  /**
   * Merge new state data and emit an action event.
   * @param {Partial<object>} newState
   */
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

  /**
   * Update the thinking text for the current step.
   * @param {string} think
   */
  trackThink(think) {
    this.state = {
      ...this.state,
      thisStep: { ...this.state.thisStep, URLTargets: [], think }
    };
    this.emit('action', this.state.thisStep);
  }

  /**
   * Get a snapshot of the tracker state.
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Reset all state to the default values.
   */
  reset() {
    this.state = {
      thisStep: { action: 'answer', answer: '', references: [], think: '' },
      gaps: [],
      totalStep: 0
    };
  }
}

// Export a shared instance so components can easily subscribe.
export const actionTracker = new ActionTracker();
