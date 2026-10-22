// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Run retention: the limits that apply to a task, which runs break them, and
 * deleting runs by hand or by sweep.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanup,
  principal,
  setupHarness,
  taskInput,
  teardownHarness
} from './helpers/scheduledTaskHarness.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import {
  effectiveRetention,
  parseRetention,
  selectRunsToPrune
} from '../services/scheduler/tasks/runRetention.js';
import { ScheduledTaskSource } from '../services/scheduler/tasks/taskSource.js';
import { newRunDocument } from '../services/scheduler/tasks/taskModel.js';
import { scheduledTaskSettings } from '../services/scheduler/tasks/taskPolicy.js';

before(() => setupHarness());
after(() => teardownHarness());

const DAY = 86_400_000;
const ada = () => principal({ id: 'user-ada', name: 'Ada' });

describe('effectiveRetention', () => {
  it('uses the stricter of the task and the platform, and 0 for none', () => {
    const settings = { maxRunsPerTask: 50, runRetentionDays: 90 };
    assert.deepEqual(effectiveRetention({}, settings), { maxRuns: 50, maxAgeDays: 90 });
    assert.deepEqual(effectiveRetention({ retention: { maxRuns: 5, maxAgeDays: 7 } }, settings), {
      maxRuns: 5,
      maxAgeDays: 7
    });
    assert.deepEqual(
      effectiveRetention({ retention: { maxRuns: 500, maxAgeDays: 700 } }, settings),
      { maxRuns: 50, maxAgeDays: 90 }
    );
    assert.deepEqual(effectiveRetention({}, { maxRunsPerTask: 0, runRetentionDays: 0 }), {
      maxRuns: 0,
      maxAgeDays: 0
    });
  });

  it('reads the platform default for the count as unlimited', () => {
    assert.equal(scheduledTaskSettings({}).maxRunsPerTask, 0);
    assert.equal(
      scheduledTaskSettings({ scheduledTasks: { maxRunsPerTask: 7 } }).maxRunsPerTask,
      7
    );
  });
});

describe('parseRetention', () => {
  it('accepts positive whole numbers and treats blanks as no limit', () => {
    assert.deepEqual(parseRetention({ maxRuns: 5, maxAgeDays: '' }).value, {
      maxRuns: 5,
      maxAgeDays: null
    });
    assert.equal(parseRetention({ maxRuns: null, maxAgeDays: null }).value, null);
    assert.equal(parseRetention(null).value, null);
  });

  it('rejects zero, fractions, text and out-of-range values', () => {
    for (const bad of [0, -1, 1.5, 'abc', 10_001]) {
      const { errors } = parseRetention({ maxRuns: bad });
      assert.equal(errors[0]?.field, 'retention.maxRuns', String(bad));
    }
    assert.equal(parseRetention({ maxAgeDays: 4000 }).errors[0].field, 'retention.maxAgeDays');
    assert.equal(parseRetention([]).errors[0].field, 'retention');
  });
});

describe('selectRunsToPrune', () => {
  const now = Date.parse('2026-06-30T12:00:00Z');
  const run = (n, status = 'succeeded', ageDays = n) => {
    const at = new Date(now - ageDays * DAY).toISOString();
    return { id: `run-${n}`, status, queuedAt: at, startedAt: at, finishedAt: at };
  };

  it('selects nothing without limits', () => {
    assert.deepEqual(selectRunsToPrune([run(1), run(400)], { maxRuns: 0, maxAgeDays: 0 }, now), []);
  });

  it('keeps the newest N finished runs', () => {
    const runs = [run(3), run(1), run(5), run(2), run(4)];
    const ids = selectRunsToPrune(runs, { maxRuns: 2, maxAgeDays: 0 }, now).map(r => r.id);
    assert.deepEqual(ids.sort(), ['run-3', 'run-4', 'run-5']);
  });

  it('selects runs older than the age limit', () => {
    const runs = [run(1), run(10), run(40)];
    const ids = selectRunsToPrune(runs, { maxRuns: 0, maxAgeDays: 30 }, now).map(r => r.id);
    assert.deepEqual(ids, ['run-40']);
  });

  it('combines both limits', () => {
    const runs = [run(1), run(2), run(3), run(40)];
    const ids = selectRunsToPrune(runs, { maxRuns: 3, maxAgeDays: 30 }, now).map(r => r.id);
    assert.deepEqual(ids, ['run-40']);
    const both = selectRunsToPrune(runs, { maxRuns: 1, maxAgeDays: 30 }, now).map(r => r.id);
    assert.deepEqual(both.sort(), ['run-2', 'run-3', 'run-40']);
  });

  it('does not let a skipped slot push the last real run out', () => {
    const skipped = { ...run(1, 'skipped'), startedAt: null };
    const runs = [skipped, run(2), run(3)];
    const ids = selectRunsToPrune(runs, { maxRuns: 1, maxAgeDays: 0 }, now).map(r => r.id);
    assert.deepEqual(ids, ['run-3']);
    // Only the age limit removes a skip record.
    const old = { ...run(40, 'skipped'), startedAt: null };
    assert.deepEqual(selectRunsToPrune([old], { maxRuns: 1, maxAgeDays: 30 }, now), [old]);
    assert.deepEqual(selectRunsToPrune([old], { maxRuns: 1, maxAgeDays: 0 }, now), []);
  });

  it('never selects a run in progress and does not count it', () => {
    const runs = [
      run(1, 'running'),
      run(2, 'queued'),
      run(3, 'awaiting_approval', 90),
      run(4),
      run(5)
    ];
    const ids = selectRunsToPrune(runs, { maxRuns: 1, maxAgeDays: 30 }, now).map(r => r.id);
    assert.deepEqual(ids, ['run-5']);
  });
});

describe('deleting and pruning runs', () => {
  async function taskWithRuns(count, { ageStepDays = 0, statuses = [] } = {}) {
    const user = ada();
    const task = await tasks.createTask(user, taskInput({ name: `retention-${Math.random()}` }));
    const repository = getScheduledTaskRepository();
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      const queuedAt = now - i * 1000 - i * ageStepDays * DAY;
      const run = newRunDocument(task, {
        trigger: 'manual',
        status: statuses[i] || 'succeeded',
        now: queuedAt
      });
      run.startedAt = new Date(queuedAt).toISOString();
      run.finishedAt = new Date(queuedAt).toISOString();
      await repository.putRun(run);
      ids.push(run.id);
    }
    return { user, task, ids, repository };
  }

  it('deletes chosen runs and reports what it did', async () => {
    const { user, task, ids, repository } = await taskWithRuns(3);
    const result = await tasks.deleteRuns(user, task.id, { runIds: [ids[0], ids[1]] });
    assert.equal(result.deleted, 2);
    assert.equal(await repository.getRun(task.id, ids[0]), null);
    assert.ok(await repository.getRun(task.id, ids[2]));
    await cleanup(user);
  });

  it('refuses to delete a run that is in progress', async () => {
    const { user, task, ids } = await taskWithRuns(1, { statuses: ['running'] });
    await assert.rejects(
      () => tasks.deleteRuns(user, task.id, { runIds: [ids[0]] }),
      error => error.status === 409
    );
    await cleanup(user);
  });

  it('deletes every finished run with `all` and keeps the active one', async () => {
    const { user, task, ids, repository } = await taskWithRuns(3, {
      statuses: ['running', 'succeeded', 'failed']
    });
    const result = await tasks.deleteRuns(user, task.id, { all: true });
    assert.equal(result.deleted, 2);
    assert.equal(result.skipped, 1);
    assert.ok(await repository.getRun(task.id, ids[0]));
    await cleanup(user);
  });

  it('does not let another user delete the runs', async () => {
    const { user, task, ids } = await taskWithRuns(1);
    await assert.rejects(
      () => tasks.deleteRuns(principal({ id: 'user-bob', name: 'Bob' }), task.id, { runIds: ids }),
      error => error.status === 404
    );
    await cleanup(user);
  });

  it('validates the selection', async () => {
    const { user, task } = await taskWithRuns(1);
    await assert.rejects(
      () => tasks.deleteRuns(user, task.id, { runIds: [] }),
      error => error.status === 400
    );
    await assert.rejects(
      () => tasks.deleteRuns(user, task.id, { runIds: ['../x'] }),
      error => error.status === 400
    );
    await cleanup(user);
  });

  it('prunes by the task count and by the task age', async () => {
    const { user, task, ids, repository } = await taskWithRuns(5, { ageStepDays: 10 });
    const settings = scheduledTaskSettings({});
    const updated = await tasks.updateTask(user, task.id, { retention: { maxRuns: 4 } });
    assert.deepEqual(updated.retention, { maxRuns: 4, maxAgeDays: null });
    assert.equal(await tasks.pruneTaskRuns(updated, settings), 1);
    assert.equal(await repository.getRun(task.id, ids[4]), null);

    const aged = await tasks.updateTask(user, task.id, { retention: { maxAgeDays: 15 } });
    assert.equal(await tasks.pruneTaskRuns(aged, settings), 2);
    assert.ok(await repository.getRun(task.id, ids[1]));
    assert.equal(await repository.getRun(task.id, ids[2]), null);
    await cleanup(user);
  });

  it('applies the platform default when the task sets none', async () => {
    const { user, task, ids, repository } = await taskWithRuns(3);
    const settings = scheduledTaskSettings({ scheduledTasks: { maxRunsPerTask: 1 } });
    assert.equal(await tasks.pruneTaskRuns(task, settings), 2);
    assert.ok(await repository.getRun(task.id, ids[0]));
    await cleanup(user);
  });

  it('after a run applies only the count limit and reads a bounded history', async () => {
    const { user, task, ids, repository } = await taskWithRuns(6, { ageStepDays: 40 });
    const settings = scheduledTaskSettings({});
    const updated = await tasks.updateTask(user, task.id, {
      retention: { maxRuns: 3, maxAgeDays: 1 }
    });
    // The age limit is left to the sweep: only the count rule deletes here.
    assert.equal(await tasks.pruneTaskRuns(updated, settings, Date.now(), { countOnly: true }), 3);
    assert.ok(await repository.getRun(task.id, ids[2]));
    assert.equal(await repository.getRun(task.id, ids[3]), null);
    // The sweep (full prune) then applies the age limit to what is left.
    assert.equal(await tasks.pruneTaskRuns(updated, settings), 2);
    await cleanup(user);
  });

  it('keeps the run record when its chat cannot be deleted', async () => {
    const { user, task, ids, repository } = await taskWithRuns(2);
    const run = await repository.getRun(task.id, ids[1]);
    // A chat the repository cannot reach: the record must survive so the delete can be retried.
    const chats = getChatRepository();
    const original = chats.getChat.bind(chats);
    chats.getChat = async () => {
      throw new Error('storage unavailable');
    };
    try {
      await repository.putRun({ ...run, chatId: 'stuck-chat' });
      const result = await tasks.deleteRuns(user, task.id, { runIds: [ids[1]] });
      assert.equal(result.deleted, 0);
      assert.equal(result.failed, 1);
      assert.ok(await repository.getRun(task.id, ids[1]));
    } finally {
      chats.getChat = original;
    }
    await cleanup(user);
  });

  it('lets an admin delete runs of any task', async () => {
    const { user, task, ids, repository } = await taskWithRuns(2);
    const result = await tasks.adminDeleteRuns(task.id, { all: true });
    assert.equal(result.deleted, 2);
    assert.equal(await repository.getRun(task.id, ids[0]), null);
    await assert.rejects(
      () => tasks.adminDeleteRuns('st-00000000-0000-0000-0000-000000000000', { all: true }),
      error => error.status === 404
    );
    await cleanup(user);
  });

  it('keeps the retention when a task is duplicated', async () => {
    const { user, task } = await taskWithRuns(0);
    await tasks.updateTask(user, task.id, { retention: { maxRuns: 3, maxAgeDays: 9 } });
    const copy = await tasks.duplicateTask(user, task.id);
    assert.deepEqual(copy.retention, { maxRuns: 3, maxAgeDays: 9 });
    await cleanup(user);
  });

  it('sweeps run records whose task is gone, once they are past the retention age', async () => {
    const { user, task, ids, repository } = await taskWithRuns(2, { ageStepDays: 100 });
    const settings = scheduledTaskSettings({ scheduledTasks: { runRetentionDays: 90 } });
    const sweep = ScheduledTaskSource.prototype.sweepOrphanRuns;
    const self = { repository: () => repository };
    // The task exists: nothing is an orphan.
    assert.equal(await sweep.call(self, new Set([task.id]), Date.now(), settings), 0);
    // The task is gone from the set: only the run past 90 days is removed.
    assert.equal(await sweep.call(self, new Set(), Date.now(), settings), 1);
    assert.ok(await repository.getRun(task.id, ids[0]));
    assert.equal(await repository.getRun(task.id, ids[1]), null);
    await cleanup(user);
  });

  it('rejects an invalid retention on save', async () => {
    const user = ada();
    await assert.rejects(
      () => tasks.createTask(user, taskInput({ retention: { maxRuns: 0 } })),
      error => error.status === 400
    );
    await cleanup(user);
  });
});
