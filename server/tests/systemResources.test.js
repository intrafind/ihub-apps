// node --test server/tests/systemResources.test.js
//
// The pure parts of the System resources collector: thresholds, cgroup
// parsing, volume grouping, and the snapshot shapes the admin page reads.
// Cross-process gathering is exercised against a real cluster in
// clusterBus.test.js.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STORAGE_THRESHOLDS,
  collectSystemResources,
  evaluateStorageStatus,
  getHostSnapshot,
  getLogFilePath,
  getProcessSnapshot,
  getStorageSnapshot,
  parseCgroupCpuMax,
  resetSystemResourcesForTests,
  startResourceSampler,
  summarizeStorage,
  worstStatus
} from '../services/systemResources.js';

after(() => resetSystemResourcesForTests());

test('storage status follows the used-percent thresholds', () => {
  assert.equal(evaluateStorageStatus(0), 'ok');
  assert.equal(evaluateStorageStatus(STORAGE_THRESHOLDS.warningPercent - 0.1), 'ok');
  assert.equal(evaluateStorageStatus(STORAGE_THRESHOLDS.warningPercent), 'warning');
  assert.equal(evaluateStorageStatus(STORAGE_THRESHOLDS.criticalPercent - 0.1), 'warning');
  assert.equal(evaluateStorageStatus(STORAGE_THRESHOLDS.criticalPercent), 'critical');
  assert.equal(evaluateStorageStatus(100), 'critical');
  // An unreadable number must not raise a false alarm.
  assert.equal(evaluateStorageStatus(NaN), 'ok');
  assert.equal(evaluateStorageStatus(50, { warningPercent: 40, criticalPercent: 60 }), 'warning');
});

test('worstStatus picks the more severe status', () => {
  assert.equal(worstStatus('ok', 'warning'), 'warning');
  assert.equal(worstStatus('critical', 'warning'), 'critical');
  assert.equal(worstStatus('ok', 'ok'), 'ok');
});

test('parseCgroupCpuMax reads cgroup v2 cpu.max', () => {
  assert.equal(parseCgroupCpuMax('max 100000\n'), null);
  assert.equal(parseCgroupCpuMax('200000 100000\n'), 2);
  assert.equal(parseCgroupCpuMax('50000 100000'), 0.5);
  assert.equal(parseCgroupCpuMax('150000 100000'), 1.5);
  assert.equal(parseCgroupCpuMax(''), null);
  assert.equal(parseCgroupCpuMax('garbage'), null);
  assert.equal(parseCgroupCpuMax('-1 100000'), null);
  assert.equal(parseCgroupCpuMax(undefined), null);
});

test('getLogFilePath only reports a log file when file logging is on', () => {
  assert.equal(getLogFilePath(undefined), null);
  assert.equal(getLogFilePath({ logging: { file: { enabled: false, path: 'x.log' } } }), null);
  assert.equal(
    getLogFilePath({ logging: { file: { enabled: true } } }),
    path.resolve('logs/app.log')
  );
  assert.equal(
    getLogFilePath({ logging: { file: { enabled: true, path: '/var/log/ihub/app.log' } } }),
    path.resolve('/var/log/ihub/app.log')
  );
});

test('paths on one filesystem share a volume; missing paths are skipped', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-sysres-'));
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  try {
    const storage = await getStorageSnapshot([
      { key: 'contents', path: a },
      { key: 'data', path: b },
      { key: 'logs', path: path.join(base, 'does-not-exist') }
    ]);

    assert.equal(storage.volumes.length, 1, 'two directories on one disk are one volume');
    const [volume] = storage.volumes;
    assert.deepEqual(
      volume.paths.map(p => p.key),
      ['contents', 'data']
    );
    assert.ok(volume.total > 0);
    assert.ok(volume.available >= 0 && volume.available <= volume.total);
    assert.ok(volume.used >= 0 && volume.used <= volume.total);
    assert.ok(volume.usedPercent >= 0 && volume.usedPercent <= 100);
    assert.equal(volume.status, evaluateStorageStatus(volume.usedPercent));
    assert.equal(storage.status, volume.status);
    assert.deepEqual(storage.thresholds, { ...STORAGE_THRESHOLDS });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('custom thresholds drive the volume status', async () => {
  const storage = await getStorageSnapshot([{ key: 'temp', path: os.tmpdir() }], {
    thresholds: { warningPercent: 0, criticalPercent: 101 }
  });
  assert.equal(storage.volumes[0].status, 'warning');
  assert.equal(storage.status, 'warning');
});

test('no readable paths yields an empty, ok snapshot and no summary', async () => {
  const storage = await getStorageSnapshot([
    { key: 'contents', path: path.join(os.tmpdir(), 'ihub-definitely-missing-dir-xyz') }
  ]);
  assert.deepEqual(storage.volumes, []);
  assert.equal(storage.status, 'ok');
  assert.equal(summarizeStorage(storage), null);
});

test('summarizeStorage reports the fullest volume and the overall status', () => {
  const summary = summarizeStorage({
    status: 'critical',
    volumes: [
      { usedPercent: 40, available: 600, total: 1000, status: 'ok' },
      { usedPercent: 95, available: 50, total: 1000, status: 'critical' }
    ]
  });
  assert.deepEqual(summary, { status: 'critical', usedPercent: 95, available: 50, total: 1000 });
});

test('process snapshot describes this process', () => {
  const snapshot = getProcessSnapshot();
  assert.equal(snapshot.pid, process.pid);
  assert.equal(snapshot.role, 'standalone');
  assert.equal(snapshot.workerIndex, null);
  assert.ok(snapshot.memory.rss > 0);
  assert.ok(snapshot.memory.heapUsed > 0);
  assert.ok(snapshot.memory.heapLimit >= snapshot.memory.heapTotal);
  // Before the first sample: the average since start, never null.
  assert.equal(typeof snapshot.cpuPercent, 'number');
});

test('the sampler fills in CPU and event-loop delay', async () => {
  startResourceSampler({ intervalMs: 50 });
  // Burn a little CPU so the window is not empty.
  const until = Date.now() + 30;
  while (Date.now() < until) {
    // spin
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  const snapshot = getProcessSnapshot();
  assert.ok(snapshot.sampledAt, 'a sample has been taken');
  assert.equal(typeof snapshot.cpuPercent, 'number');
  assert.ok(snapshot.cpuPercent >= 0);
  const host = await getHostSnapshot();
  assert.equal(typeof host.cpu.utilizationPercent, 'number');
  resetSystemResourcesForTests();
});

test('host snapshot honours the memory limit it reports', async () => {
  const host = await getHostSnapshot();
  assert.ok(host.cpu.cores >= 1);
  assert.ok(host.memory.total > 0);
  assert.ok(host.memory.total <= host.memory.hostTotal);
  assert.ok(host.memory.available >= 0 && host.memory.available <= host.memory.total);
  assert.equal(host.memory.used, host.memory.total - host.memory.available);
  assert.equal(host.nodeVersion, process.version);
  if (host.cpu.limitCores !== null) assert.ok(host.cpu.limitCores > 0);
});

test('outside cluster mode the collector reports one standalone process', async () => {
  const snapshot = await collectSystemResources();
  assert.equal(snapshot.cluster.mode, 'standalone');
  assert.equal(snapshot.cluster.configuredWorkers, 1);
  assert.deepEqual(snapshot.cluster.missingWorkers, []);
  assert.equal(snapshot.cluster.primaryReported, null);
  assert.equal(snapshot.processes.length, 1);
  assert.equal(snapshot.processes[0].pid, process.pid);
  assert.equal(snapshot.processes[0].current, true);
  assert.ok(Array.isArray(snapshot.storage.volumes));
  assert.ok(snapshot.host.memory.total > 0);
});
