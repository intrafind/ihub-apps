/**
 * The scheduler: slot planning (run, overlap skip, catch-up, missed),
 * run outcomes (completion, auto-pause), the task source over a real
 * filesystem store (one claim per slot, restart recovery), the owner-only
 * tick, and workflow schedule triggers read from the config.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { normalizeSchedule } from '../services/scheduler/schedule.js';
import { ScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import {
  applyRunOutcome,
  newRunDocument,
  newTaskDocument,
  planDueSlot,
  resolveRunContext,
  runContextVariables,
  attachQueuedRun
} from '../services/scheduler/tasks/taskModel.js';
import { ScheduledTaskSource } from '../services/scheduler/tasks/taskSource.js';
import { ScheduledTaskRunner } from '../services/scheduler/tasks/taskRunner.js';
import { SchedulerService } from '../services/scheduler/SchedulerService.js';
import { WorkflowTriggerSource } from '../services/scheduler/workflowTriggerSource.js';
import { DEFAULT_SCHEDULED_TASK_SETTINGS } from '../services/scheduler/tasks/taskPolicy.js';
import { formatZonedIso } from '../services/scheduler/schedule.js';

const SETTINGS = { ...DEFAULT_SCHEDULED_TASK_SETTINGS, staggerMinutes: 0 };
const T0 = Date.parse('2026-10-23T08:00:00Z');
const HOUR = 3_600_000;

function task(
  scheduleInput,
  { now = T0, id = 'st-00000000-0000-4000-8000-000000000001', settings = SETTINGS } = {}
) {
  return newTaskDocument(
    {
      name: 'Digest',
      instructions: 'Summarize since {{last_successful_run_at}} at {{run_time}}',
      appId: 'chat',
      schedule: normalizeSchedule(scheduleInput, { now, timezone: 'UTC' }),
      notify: 'always'
    },
    {
      id,
      ownerId: 'user-1',
      owner: { userId: 'user-1', groups: ['users'] },
      now,
      staggerMinutes: settings.staggerMinutes
    }
  );
}

describe('planDueSlot', () => {
  it('does nothing before the slot', () => {
    const t = task({ type: 'daily', time: '09:00' });
    assert.equal(planDueSlot(t, { now: T0, settings: SETTINGS }), null);
  });

  it('queues the slot that is due and moves to the next one', () => {
    const t = task({ type: 'daily', time: '09:00' });
    const plan = planDueSlot(t, { now: T0 + HOUR + 1000, settings: SETTINGS });
    assert.equal(plan.queued.trigger, 'schedule');
    assert.equal(plan.queued.scheduledFor, '2026-10-23T09:00:00.000Z');
    assert.equal(plan.task.activeRun.id, plan.queued.id);
    assert.equal(plan.task.nextSlotAt, '2026-10-24T09:00:00.000Z');
    assert.equal(plan.task.runNumber, 1);
    assert.equal(plan.task.scheduledRunCount, 1);
  });

  it('skips the slot while the previous run is still in flight', () => {
    const t = task({ type: 'daily', time: '09:00' });
    t.activeRun = { id: 'r-prev', status: 'running' };
    const plan = planDueSlot(t, { now: T0 + HOUR + 1000, settings: SETTINGS });
    assert.equal(plan.queued, null);
    assert.equal(plan.runs.length, 1);
    assert.equal(plan.runs[0].status, 'skipped');
    assert.equal(plan.runs[0].reason.code, 'PREVIOUS_RUN_ACTIVE');
    assert.equal(plan.task.activeRun.id, 'r-prev');
    assert.equal(plan.task.nextSlotAt, '2026-10-24T09:00:00.000Z');
  });

  it('catches up the latest missed slot inside the window and records the rest', () => {
    const t = task({ type: 'daily', time: '09:00' });
    // Down from before the 09:00 slot on day 1 until 10:00 on day 4.
    const now = Date.parse('2026-10-26T10:00:00Z');
    const plan = planDueSlot(t, { now, settings: SETTINGS });
    assert.equal(plan.queued.trigger, 'catch-up');
    assert.equal(plan.queued.scheduledFor, '2026-10-26T09:00:00.000Z');
    const skipped = plan.runs.filter(run => run.status === 'skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason.code, 'MISSED');
    assert.equal(skipped[0].missedSlots, 3);
    assert.equal(plan.task.nextSlotAt, '2026-10-27T09:00:00.000Z');
  });

  it('runs nothing when the latest missed slot is outside the window', () => {
    const t = task({ type: 'weekly', time: '09:00', days: [5] });
    const now = Date.parse('2026-10-26T10:00:00Z'); // the Friday 09:00 was three days ago
    const plan = planDueSlot(t, { now, settings: { ...SETTINGS, catchUpWindowHours: 24 } });
    assert.equal(plan.queued, null);
    assert.equal(plan.runs[0].reason.code, 'MISSED');
    assert.equal(plan.task.status, 'active');
    assert.equal(plan.task.nextSlotAt, '2026-10-30T09:00:00.000Z');
  });

  it('a one-time task missed outside the window completes', () => {
    const t = task({ type: 'once', at: '2026-10-23T09:00' });
    const plan = planDueSlot(t, { now: Date.parse('2026-10-25T09:00:00Z'), settings: SETTINGS });
    assert.equal(plan.queued, null);
    assert.equal(plan.task.status, 'completed');
    assert.equal(plan.task.statusReason.code, 'MISSED');
  });

  it('a one-time task missed inside the window runs once', () => {
    const t = task({ type: 'once', at: '2026-10-23T09:00' });
    const plan = planDueSlot(t, { now: Date.parse('2026-10-23T12:00:00Z'), settings: SETTINGS });
    assert.equal(plan.queued.trigger, 'catch-up');
    assert.equal(plan.task.nextRunAt, null);
  });

  it('applies the stagger to the start, not to the slot', () => {
    const staggered = { ...SETTINGS, staggerMinutes: 5 };
    const t = task({ type: 'daily', time: '09:00' }, { settings: staggered });
    const offset = Date.parse(t.nextRunAt) - Date.parse(t.nextSlotAt);
    assert.ok(offset >= 0 && offset < 5 * 60_000);
    // Due only once the staggered start has passed.
    const due = Date.parse(t.nextRunAt);
    if (offset > 0) assert.equal(planDueSlot(t, { now: due - 1, settings: staggered }), null);
    assert.ok(planDueSlot(t, { now: due, settings: staggered }).queued);
  });
});

describe('applyRunOutcome', () => {
  it('completes a one-time task after its run', () => {
    const t = task({ type: 'once', at: '2026-10-23T09:00' });
    const plan = planDueSlot(t, { now: Date.parse('2026-10-23T09:00:01Z'), settings: SETTINGS });
    const run = { ...plan.queued, status: 'succeeded', startedAt: '2026-10-23T09:00:02Z' };
    const next = applyRunOutcome(plan.task, run, { now: Date.now(), settings: SETTINGS });
    assert.equal(next.status, 'completed');
    assert.equal(next.statusReason.code, 'ONCE');
    assert.equal(next.activeRun, null);
    assert.equal(next.lastSuccessfulRunAt, '2026-10-23T09:00:02Z');
  });

  it('completes after max runs', () => {
    let t = task({ type: 'daily', time: '09:00', maxRuns: 1 });
    const plan = planDueSlot(t, { now: T0 + HOUR, settings: SETTINGS });
    assert.equal(plan.task.nextRunAt, null);
    t = applyRunOutcome(
      plan.task,
      { ...plan.queued, status: 'succeeded', startedAt: 'x' },
      {
        now: T0 + HOUR,
        settings: SETTINGS
      }
    );
    assert.equal(t.status, 'completed');
    assert.equal(t.statusReason.code, 'MAX_RUNS');
  });

  it('pauses after too many failures in a row, and a success resets the count', () => {
    let t = task({ type: 'daily', time: '09:00' });
    const fail = () => {
      const run = newRunDocument(t, { trigger: 'manual', status: 'queued', now: T0 });
      attachQueuedRun(t, run);
      t = applyRunOutcome(
        t,
        { ...run, status: 'failed', startedAt: 'x', reason: { message: 'boom' } },
        {
          now: T0,
          settings: SETTINGS
        }
      );
    };
    fail();
    fail();
    const ok = newRunDocument(t, { trigger: 'manual', status: 'queued', now: T0 });
    attachQueuedRun(t, ok);
    t = applyRunOutcome(
      t,
      { ...ok, status: 'succeeded', startedAt: 'x' },
      { now: T0, settings: SETTINGS }
    );
    assert.equal(t.consecutiveFailures, 0);
    fail();
    fail();
    fail();
    assert.equal(t.status, 'paused');
    assert.equal(t.statusReason.code, 'TOO_MANY_FAILURES');
    assert.equal(t.nextRunAt, null);
  });

  it('notifies according to the task setting', () => {
    const t = task({ type: 'manual' });
    t.notify = 'failure';
    const run = {
      ...newRunDocument(t, { trigger: 'manual', status: 'queued', now: T0 }),
      startedAt: 'x'
    };
    applyRunOutcome(t, { ...run, status: 'succeeded' }, { now: T0, settings: SETTINGS });
    assert.equal(t.unseenRuns.length, 0);
    applyRunOutcome(t, { ...run, id: 'r-2', status: 'failed' }, { now: T0, settings: SETTINGS });
    assert.equal(t.unseenRuns.length, 1);
  });
});

describe('run-context variables', () => {
  it('fills the known variables and leaves app variables alone', () => {
    const t = task({ type: 'manual' });
    t.schedule.timezone = 'Europe/Berlin';
    const run = { runNumber: 3, trigger: 'manual', scheduledFor: '2026-10-23T07:00:00Z' };
    const values = runContextVariables(t, run, {
      now: Date.parse('2026-10-23T07:00:00Z'),
      format: formatZonedIso
    });
    const text = resolveRunContext(
      'Run {{run_number}} at {{run_time}} since {{last_successful_run_at}} for {{topic}}',
      values
    );
    assert.equal(text, 'Run 3 at 2026-10-23T09:00:00+02:00 since never for {{topic}}');
  });
});

// ── the source over a real store ────────────────────────────────────────────

let baseDir;
let provider;
let repository;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-scheduled-tasks-'));
  provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });
  await provider.initialize();
  repository = new ScheduledTaskRepository({
    documents: provider.documents,
    locks: provider.locks
  });
});

after(async () => {
  await provider.shutdown?.();
  await fs.rm(baseDir, { recursive: true, force: true });
});

function fakeRunner() {
  const jobs = [];
  return {
    jobs,
    running: new Set(),
    has(runId) {
      return jobs.some(job => job.runId === runId);
    },
    isRunning(runId) {
      return this.running.has(runId);
    },
    enqueue(job) {
      if (!this.has(job.runId)) jobs.push(job);
    },
    clearQueue() {},
    describe: () => ({})
  };
}

function source(runner) {
  return new ScheduledTaskSource({
    repository: () => repository,
    runner,
    policy: () => ({ configured: true, settings: SETTINGS })
  });
}

let counter = 0;
function freshId() {
  counter += 1;
  return `st-00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

describe('ScheduledTaskSource', () => {
  it('claims a due slot exactly once, even when two ticks race', async () => {
    const t = task({ type: 'daily', time: '09:00' }, { id: freshId() });
    await repository.createTask(t);
    const runner = fakeRunner();
    const src = source(runner);
    await src.rebuild({ now: T0, reason: 'owner' });
    const now = T0 + HOUR + 1000;
    await Promise.all([src.runDue({ now }), src.runDue({ now })]);
    assert.equal(runner.jobs.filter(job => job.taskId === t.id).length, 1);
    const { items } = await repository.listRuns(t.id);
    assert.equal(items.filter(run => run.status === 'queued').length, 1);
    const stored = await repository.getTask(t.id);
    assert.equal(stored.activeRun.status, 'queued');
    assert.equal(stored.nextSlotAt, '2026-10-24T09:00:00.000Z');
  });

  it('a second source (another owner after failover) does not claim the same slot again', async () => {
    const t = task({ type: 'daily', time: '09:00' }, { id: freshId() });
    await repository.createTask(t);
    const now = T0 + HOUR + 1000;
    const first = source(fakeRunner());
    await first.rebuild({ now: T0, reason: 'owner' });
    await first.runDue({ now });
    const secondRunner = fakeRunner();
    const second = source(secondRunner);
    await second.rebuild({ now, reason: 'owner' });
    await second.runDue({ now });
    // The queued run is handed over, not claimed twice.
    const { items } = await repository.listRuns(t.id);
    assert.equal(items.length, 1);
    const handedOver = secondRunner.jobs.filter(job => job.taskId === t.id);
    assert.equal(handedOver.length, 1);
    assert.equal(handedOver[0].runId, items[0].id);
  });

  it('fails a run the previous owner was executing when it died', async () => {
    const t = task({ type: 'daily', time: '09:00' }, { id: freshId() });
    const run = newRunDocument(t, { trigger: 'manual', status: 'queued', now: T0 });
    attachQueuedRun(t, run);
    t.activeRun.status = 'running';
    await repository.createTask(t);
    await repository.putRun({ ...run, status: 'running', startedAt: new Date(T0).toISOString() });
    const src = source(fakeRunner());
    await src.rebuild({ now: T0 + 1000, reason: 'owner' });
    const stored = await repository.getTask(t.id);
    assert.equal(stored.activeRun, null);
    assert.equal(stored.lastRun.status, 'failed');
    const storedRun = await repository.getRun(t.id, run.id);
    assert.equal(storedRun.reason.code, 'INTERRUPTED');
  });

  it('leaves a run alone while its worker still renews the lease, and recovers it once lapsed', async () => {
    const t = task({ type: 'daily', time: '09:00' }, { id: freshId() });
    const run = newRunDocument(t, { trigger: 'manual', status: 'queued', now: T0 });
    attachQueuedRun(t, run);
    t.activeRun.status = 'running';
    await repository.createTask(t);
    // The previous owner lost the scheduler lock but is still executing.
    await repository.putRun({
      ...run,
      status: 'running',
      startedAt: new Date(T0).toISOString(),
      execution: { token: 'old-worker', leaseUntil: new Date(T0 + 60_000).toISOString() }
    });
    const src = source(fakeRunner());
    await src.rebuild({ now: T0 + 1000, reason: 'owner' });
    assert.equal((await repository.getRun(t.id, run.id)).status, 'running');
    assert.equal((await repository.getTask(t.id)).activeRun.id, run.id);

    // Its lease ran out without a renewal: the process is gone after all.
    await src.rebuild({ now: T0 + 120_000, reason: 'periodic' });
    const recovered = await repository.getRun(t.id, run.id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.reason.code, 'INTERRUPTED');
    assert.equal((await repository.getTask(t.id)).activeRun, null);
  });

  it('releases a task whose running run has no document at all', async () => {
    const t = task({ type: 'daily', time: '09:00' }, { id: freshId() });
    const run = newRunDocument(t, { trigger: 'manual', status: 'queued', now: T0 });
    attachQueuedRun(t, run);
    t.activeRun.status = 'running';
    await repository.createTask(t);
    // The run document was never written, or was deleted out of band.
    const src = source(fakeRunner());
    await src.rebuild({ now: T0 + 1000, reason: 'periodic' });
    const stored = await repository.getTask(t.id);
    assert.equal(stored.activeRun, null);
    assert.equal(stored.lastRun.status, 'failed');
  });

  it('catches up after a restart: one run for the latest missed slot', async () => {
    const t = task({ type: 'daily', time: '09:00' }, { id: freshId() });
    await repository.createTask(t);
    const runner = fakeRunner();
    const src = source(runner);
    const now = Date.parse('2026-10-25T09:30:00Z');
    await src.rebuild({ now, reason: 'owner' });
    await src.runDue({ now });
    const { items } = await repository.listRuns(t.id);
    const queued = items.filter(run => run.status === 'queued');
    const skipped = items.filter(run => run.status === 'skipped');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].trigger, 'catch-up');
    assert.equal(queued[0].scheduledFor, '2026-10-25T09:00:00.000Z');
    assert.equal(skipped[0].missedSlots, 2);
    assert.equal(runner.jobs.filter(job => job.taskId === t.id).length, 1);
  });

  it('lists runs newest first', async () => {
    const t = task({ type: 'manual' }, { id: freshId() });
    await repository.createTask(t);
    for (let i = 0; i < 3; i++) {
      await repository.putRun(
        newRunDocument(t, { trigger: 'manual', status: 'succeeded', now: T0 + i * 1000 })
      );
    }
    const { items } = await repository.listRuns(t.id, { limit: 2 });
    assert.equal(items.length, 2);
    assert.ok(Date.parse(items[0].queuedAt) > Date.parse(items[1].queuedAt));
  });
});

describe('ScheduledTaskRunner', () => {
  it('respects the global and per-owner limits', async () => {
    const release = [];
    const started = [];
    const runner = new ScheduledTaskRunner({
      execute: job =>
        new Promise(resolve => {
          started.push(job.runId);
          release.push(resolve);
        }),
      limits: () => ({ maxConcurrentRuns: 2, maxConcurrentRunsPerUser: 1 })
    });
    runner.enqueue({ taskId: 'a', runId: 'r1', ownerId: 'u1' });
    runner.enqueue({ taskId: 'b', runId: 'r2', ownerId: 'u1' });
    runner.enqueue({ taskId: 'c', runId: 'r3', ownerId: 'u2' });
    runner.enqueue({ taskId: 'd', runId: 'r4', ownerId: 'u3' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['r1', 'r3']);
    release.shift()();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(started, ['r1', 'r3', 'r2']);
    release.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 5));
    release.forEach(fn => fn());
    await runner.drain();
    assert.equal(started.length, 4);
  });
});

describe('SchedulerService', () => {
  it('only the lock owner ticks its sources', async () => {
    let owner = false;
    const calls = [];
    const scheduler = new SchedulerService({ isOwner: () => owner, now: () => T0 });
    scheduler.registerSource({
      id: 'probe',
      rebuild: async ({ reason }) => calls.push(`rebuild:${reason}`),
      runDue: async () => calls.push('runDue'),
      clear: () => calls.push('clear')
    });
    await scheduler.tick();
    assert.deepEqual(calls, []);
    owner = true;
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(calls, ['rebuild:owner', 'runDue', 'runDue']);
    owner = false;
    await scheduler.tick();
    assert.deepEqual(calls.slice(-1), ['clear']);
  });

  it('retries a failed ownership rebuild as `owner`, so recovery still runs', async () => {
    const reasons = [];
    let failures = 1;
    const scheduler = new SchedulerService({ isOwner: () => true, now: () => T0 });
    scheduler.registerSource({
      id: 'flaky',
      rebuild: async ({ reason }) => {
        reasons.push(reason);
        if (failures-- > 0) throw new Error('storage briefly unavailable');
      },
      runDue: async () => {}
    });
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    // The recovery a new owner owes is not downgraded to a periodic rebuild,
    // and once it succeeded it is not repeated.
    assert.deepEqual(reasons, ['owner', 'owner']);
  });
});

describe('WorkflowTriggerSource', () => {
  it('fires a due schedule trigger once and follows config edits without a restart', async () => {
    let workflows = [
      {
        id: 'wf',
        triggers: [{ id: 'daily', type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' }]
      }
    ];
    let etag = 'v1';
    const fired = [];
    const src = new WorkflowTriggerSource({
      getWorkflows: () => ({ data: workflows, etag }),
      fire: async (workflowId, trigger) => fired.push(`${workflowId}:${trigger.id}`),
      isEnabled: () => true
    });
    await src.rebuild({ now: T0 });
    assert.equal(src.describe()[0].nextRun, '2026-10-23T09:00:00.000Z');
    await src.runDue({ now: T0 + HOUR + 1000 });
    await src.runDue({ now: T0 + HOUR + 2000 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fired, ['wf:daily']);
    // An edit: a second trigger, picked up on the next tick.
    workflows = [
      {
        id: 'wf',
        triggers: [
          { id: 'daily', type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' },
          { id: 'noon', type: 'schedule', cron: '0 12 * * *', timezone: 'UTC' }
        ]
      }
    ];
    etag = 'v2';
    await src.runDue({ now: T0 + 4 * HOUR + 1000 });
    await new Promise(resolve => setImmediate(resolve));
    // Noon was computed from the edit, after 12:00 — it runs tomorrow.
    assert.deepEqual(fired, ['wf:daily']);
    assert.equal(src.describe().length, 2);
    // Removing the workflow removes its triggers.
    workflows = [];
    etag = 'v3';
    await src.runDue({ now: T0 + 5 * HOUR });
    assert.equal(src.describe().length, 0);
  });

  it('skips a slot found long after its time instead of firing late', async () => {
    const fired = [];
    const src = new WorkflowTriggerSource({
      getWorkflows: () => ({
        data: [{ id: 'wf', triggers: [{ id: 't', type: 'schedule', cron: '0 9 * * *' }] }],
        etag: 'x'
      }),
      fire: async () => fired.push('x'),
      isEnabled: () => true
    });
    await src.rebuild({ now: T0 });
    await src.runDue({ now: T0 + 3 * HOUR });
    assert.deepEqual(fired, []);
    assert.equal(src.describe()[0].nextRun, '2026-10-24T09:00:00.000Z');
  });
});
