// node --test server/tests/storageMonitor.test.js
//
// When the background disk check writes to the log: once when a volume
// crosses a threshold, again only as an hourly reminder while it stays there,
// once when it recovers, and never while it is fine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStorageMonitor,
  describeStorageEvent,
  evaluateStorageAlerts
} from '../services/storageMonitor.js';

const GiB = 1024 ** 3;
const HOUR = 60 * 60 * 1000;

function volume(status, usedPercent, path = '/app/contents') {
  return {
    paths: [
      { key: 'contents', path },
      { key: 'temp', path: '/tmp' }
    ],
    total: 20 * GiB,
    available: ((100 - usedPercent) / 100) * 20 * GiB,
    used: (usedPercent / 100) * 20 * GiB,
    usedPercent,
    status
  };
}

const snapshot = (...volumes) => ({
  status: 'ok',
  thresholds: { warningPercent: 80, criticalPercent: 90 },
  volumes
});

test('a healthy volume is never logged, not even at startup', () => {
  const { events, next } = evaluateStorageAlerts(new Map(), snapshot(volume('ok', 40)));
  assert.deepEqual(events, []);
  assert.equal(next.get('/app/contents').status, 'ok');
});

test('a volume that is already low at startup is logged straight away', () => {
  const { events } = evaluateStorageAlerts(new Map(), snapshot(volume('warning', 85)), {
    now: 0
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'entered');
  assert.equal(events[0].status, 'warning');
  assert.equal(events[0].previousStatus, null);
});

test('crossing into warning, then critical, logs each crossing once', () => {
  let state = new Map();
  let result = evaluateStorageAlerts(state, snapshot(volume('ok', 70)), { now: 0 });
  state = result.next;

  result = evaluateStorageAlerts(state, snapshot(volume('warning', 82)), { now: 1000 });
  assert.deepEqual(
    result.events.map(e => [e.kind, e.status, e.previousStatus]),
    [['entered', 'warning', 'ok']]
  );
  state = result.next;

  // Same status on the next check: silent.
  result = evaluateStorageAlerts(state, snapshot(volume('warning', 83)), { now: 2000 });
  assert.deepEqual(result.events, []);
  state = result.next;

  result = evaluateStorageAlerts(state, snapshot(volume('critical', 93)), { now: 3000 });
  assert.deepEqual(
    result.events.map(e => [e.kind, e.status, e.previousStatus]),
    [['entered', 'critical', 'warning']]
  );
});

test('a volume that stays low is reminded about once per reminder period', () => {
  let state = evaluateStorageAlerts(new Map(), snapshot(volume('critical', 95)), {
    now: 0
  }).next;

  let result = evaluateStorageAlerts(state, snapshot(volume('critical', 95)), {
    now: HOUR - 1,
    reminderMs: HOUR
  });
  assert.deepEqual(result.events, [], 'not before the period is over');
  state = result.next;

  result = evaluateStorageAlerts(state, snapshot(volume('critical', 96)), {
    now: HOUR,
    reminderMs: HOUR
  });
  assert.deepEqual(
    result.events.map(e => e.kind),
    ['reminder']
  );
  state = result.next;

  // The reminder resets the clock.
  result = evaluateStorageAlerts(state, snapshot(volume('critical', 96)), {
    now: HOUR + 60_000,
    reminderMs: HOUR
  });
  assert.deepEqual(result.events, []);
});

test('dropping back below the warning threshold is logged as a recovery', () => {
  const state = evaluateStorageAlerts(new Map(), snapshot(volume('critical', 91)), {
    now: 0
  }).next;
  const { events, next } = evaluateStorageAlerts(state, snapshot(volume('ok', 60)), {
    now: 1000
  });
  assert.deepEqual(
    events.map(e => [e.kind, e.previousStatus]),
    [['recovered', 'critical']]
  );
  assert.equal(next.get('/app/contents').status, 'ok');
});

test('volumes are tracked independently and a vanished one is forgotten', () => {
  let state = evaluateStorageAlerts(
    new Map(),
    snapshot(volume('warning', 85, '/app/contents'), volume('ok', 10, '/app/logs')),
    { now: 0 }
  ).next;
  assert.equal(state.size, 2);

  const result = evaluateStorageAlerts(state, snapshot(volume('critical', 92, '/app/logs')), {
    now: 1000
  });
  assert.deepEqual(
    result.events.map(e => [e.volume.paths[0].path, e.status]),
    [['/app/logs', 'critical']]
  );
  assert.equal(result.next.has('/app/contents'), false);
  state = result.next;
});

test('log levels and messages: warn for low, error for critical, info on recovery', () => {
  const low = describeStorageEvent({
    kind: 'entered',
    status: 'warning',
    previousStatus: 'ok',
    volume: volume('warning', 85)
  });
  assert.equal(low.level, 'warn');
  assert.equal(low.entry.component, 'StorageMonitor');
  assert.match(low.entry.message, /Disk space running low on the volume holding contents, temp/);
  assert.match(low.entry.message, /3\.0 GB free of 20\.0 GB \(85% used\)/);
  assert.equal(low.entry.availableBytes, 3 * GiB);
  assert.deepEqual(low.entry.paths, ['/app/contents', '/tmp']);
  assert.equal(low.entry.warningPercent, 80);

  const critical = describeStorageEvent({
    kind: 'reminder',
    status: 'critical',
    previousStatus: 'critical',
    volume: volume('critical', 95)
  });
  assert.equal(critical.level, 'error');
  assert.match(critical.entry.message, /critically low/);
  assert.match(critical.entry.message, /\(still\)$/);

  const recovered = describeStorageEvent({
    kind: 'recovered',
    status: 'ok',
    previousStatus: 'warning',
    volume: volume('ok', 50)
  });
  assert.equal(recovered.level, 'info');
  assert.match(recovered.entry.message, /back to normal/);
});

test('the monitor logs through the given logger and survives a failing probe', async () => {
  const logged = [];
  let next = snapshot(volume('ok', 50));
  let clock = 0;
  const monitor = createStorageMonitor({
    getSnapshot: async () => {
      if (next instanceof Error) throw next;
      return next;
    },
    log: (level, entry) => logged.push([level, entry.event, entry.status]),
    reminderMs: HOUR,
    now: () => clock
  });

  await monitor.check();
  assert.deepEqual(logged, []);

  next = snapshot(volume('warning', 88));
  clock = 1000;
  await monitor.check();
  assert.deepEqual(logged, [['warn', 'entered', 'warning']]);

  next = new Error('statfs failed');
  clock = 2000;
  assert.deepEqual(await monitor.check(), [], 'a failed probe logs nothing and does not throw');

  next = snapshot(volume('warning', 88));
  clock = 3000;
  await monitor.check();
  assert.equal(logged.length, 1, 'the failed probe did not reset what was already reported');
});
