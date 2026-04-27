/**
 * ActivityTracker drives the periodic "Activity summary" log line and the
 * ihub.active.users / ihub.active.chats observable gauges. These tests
 * exercise the rolling-window pruning, hot-reload of the window/interval,
 * and the dynamic-attribute getter exposed to the gauge observers.
 *
 * The metrics module is left un-initialized so registerActivityObservers
 * is a no-op; we test ActivityTracker's own behaviour directly without
 * needing a real OpenTelemetry meter.
 */

import activityTracker from '../telemetry/ActivityTracker.js';

describe('ActivityTracker', () => {
  beforeEach(() => {
    activityTracker.shutdown();
    activityTracker.userTimestamps.clear();
    activityTracker.chatTimestamps.clear();
    activityTracker.lastReportedUsers = 0;
    activityTracker.lastReportedChats = 0;
  });

  afterAll(() => {
    activityTracker.shutdown();
  });

  test('records distinct users and chats independently', () => {
    activityTracker.configure({ enabled: false, windowMinutes: 5, intervalSeconds: 60 });

    activityTracker.recordActivity({ userId: 'alice', chatId: 'c1' });
    activityTracker.recordActivity({ userId: 'bob' });
    activityTracker.recordActivity({ chatId: 'c2' });
    activityTracker.recordActivity({ userId: 'alice' }); // dedup by id

    expect(activityTracker.getActiveUsers()).toBe(2);
    expect(activityTracker.getActiveChats()).toBe(2);
  });

  test('prunes entries older than the rolling window', () => {
    activityTracker.configure({ enabled: false, windowMinutes: 5, intervalSeconds: 60 });

    const now = Date.now();
    activityTracker.userTimestamps.set('stale', now - 10 * 60 * 1000); // 10 min old
    activityTracker.userTimestamps.set('fresh', now - 1 * 60 * 1000);

    expect(activityTracker.getActiveUsers()).toBe(1);
    expect(activityTracker.userTimestamps.has('stale')).toBe(false);
  });

  test('reconfigure() updates the window without losing existing entries', () => {
    activityTracker.configure({ enabled: false, windowMinutes: 60, intervalSeconds: 60 });
    activityTracker.recordActivity({ userId: 'alice' });

    activityTracker.configure({ enabled: false, windowMinutes: 30, intervalSeconds: 60 });
    expect(activityTracker.windowMs).toBe(30 * 60 * 1000);
    expect(activityTracker.getActiveUsers()).toBe(1);
  });

  test('intervalSeconds is clamped to a sane minimum', () => {
    activityTracker.configure({ enabled: true, intervalSeconds: 1 });
    // Floor is 10s -> 10000ms
    expect(activityTracker.summaryIntervalMs).toBe(10 * 1000);
    activityTracker.shutdown();
  });

  test('disabling the summary clears the interval timer', () => {
    activityTracker.configure({ enabled: true, intervalSeconds: 60 });
    expect(activityTracker.summaryTimer).not.toBeNull();

    activityTracker.configure({ enabled: false });
    expect(activityTracker.summaryTimer).toBeNull();
  });
});
