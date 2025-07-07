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
      thisStep: { action: 'answer', answer: '', references: [], think: '' },
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
    this.emit('action', this.state.thisStep);
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
