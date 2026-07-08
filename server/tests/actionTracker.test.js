/**
 * Unit tests for ActionTracker's per-chat step isolation.
 *
 * trackAction used to increment a single process-wide `steps` counter shared
 * by every chat, so concurrent chats saw a contaminated, ever-growing step
 * number. It's now tracked per chatId and cleared when a chat's turn ends.
 */

import { ActionTracker } from '../actionTracker.js';

describe('ActionTracker per-chat step counter', () => {
  test('tracks independent, correctly incrementing steps per chatId', () => {
    const tracker = new ActionTracker();
    const events = [];
    tracker.on('fire-sse', event => events.push(event));

    tracker.trackAction('chat-a', {});
    tracker.trackAction('chat-b', {});
    tracker.trackAction('chat-a', {});

    const stepsFor = chatId => events.filter(e => e.chatId === chatId).map(e => e.steps);
    expect(stepsFor('chat-a')).toEqual([1, 2]);
    expect(stepsFor('chat-b')).toEqual([1]);
  });

  test.each(['trackDone', 'trackError', 'trackDisconnected'])(
    '%s clears the step counter so the next turn restarts at 1',
    method => {
      const tracker = new ActionTracker();
      const events = [];
      tracker.on('fire-sse', event => events.push(event));

      tracker.trackAction('chat-a', {});
      tracker.trackAction('chat-a', {});
      tracker[method]('chat-a');
      tracker.trackAction('chat-a', {});

      const steps = events.filter(e => e.event === 'action').map(e => e.steps);
      expect(steps).toEqual([1, 2, 1]);
    }
  );

  test('does not warn about exceeding the default max listener count', () => {
    const tracker = new ActionTracker();
    const warnings = [];
    const onWarning = warning => warnings.push(warning);
    process.on('warning', onWarning);

    try {
      for (let i = 0; i < 15; i += 1) {
        tracker.on('fire-sse', () => {});
      }
    } finally {
      process.off('warning', onWarning);
    }

    expect(warnings.some(w => w.name === 'MaxListenersExceededWarning')).toBe(false);
  });
});
