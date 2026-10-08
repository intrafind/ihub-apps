/**
 * Memory between runs as a property of a task: how the setting is validated,
 * copied and kept, when the owner is notified once "only when something
 * changed" exists, and how the platform limits are read.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import {
  cleanup,
  principal,
  setupHarness,
  taskInput,
  teardownHarness
} from './helpers/scheduledTaskHarness.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import {
  NOTIFY_MODES,
  newTaskDocument,
  shouldNotify
} from '../services/scheduler/tasks/taskModel.js';
import {
  DEFAULT_SCHEDULED_TASK_SETTINGS,
  scheduledTaskSettings,
  scheduledTasksClientConfig
} from '../services/scheduler/tasks/taskPolicy.js';
import { writeTaskMemory } from '../services/scheduler/tasks/taskMemory.js';

before(() => setupHarness());
after(() => teardownHarness());

const ada = () => principal({ id: 'user-ada', name: 'Ada' });

describe('notify modes', () => {
  it('has the new mode after the old ones', () => {
    assert.deepEqual([...NOTIFY_MODES], ['always', 'failure', 'never', 'changes']);
  });
});

describe('shouldNotify', () => {
  const run = (status, memory, chatId = 'chat-1') => ({
    status,
    chatId,
    ...(memory === undefined ? {} : { memory })
  });
  const memory = changed => ({ enabled: true, changed });

  it('keeps the old modes exactly as they were', () => {
    for (const memoryState of [undefined, memory(true), memory(false), memory(null)]) {
      assert.equal(shouldNotify({ notify: 'always' }, run('succeeded', memoryState)), true);
      assert.equal(shouldNotify({ notify: 'always' }, run('failed', memoryState)), true);
      assert.equal(shouldNotify({ notify: 'always' }, run('cancelled', memoryState)), false);
      assert.equal(shouldNotify({ notify: 'failure' }, run('succeeded', memoryState)), false);
      assert.equal(shouldNotify({ notify: 'failure' }, run('failed', memoryState)), true);
      assert.equal(shouldNotify({ notify: 'never' }, run('failed', memoryState)), false);
      assert.equal(shouldNotify({ notify: 'never' }, run('awaiting_approval', memoryState)), false);
    }
  });

  describe('"only when something changed"', () => {
    const task = { notify: 'changes' };

    it('notifies a run that reported something new', () => {
      assert.equal(shouldNotify(task, run('succeeded', memory(true))), true);
    });

    it('stays quiet for a run that found nothing new', () => {
      assert.equal(shouldNotify(task, run('succeeded', memory(false))), false);
    });

    it('notifies when it could not tell: a missed report costs more than one too many', () => {
      assert.equal(shouldNotify(task, run('succeeded', memory(null))), true);
      assert.equal(shouldNotify(task, run('succeeded', { enabled: true })), true);
    });

    it('always notifies a failure, whatever the verdict', () => {
      for (const changed of [true, false, null]) {
        assert.equal(shouldNotify(task, run('failed', memory(changed))), true);
      }
    });

    it('asks for an approval whatever the verdict', () => {
      assert.equal(shouldNotify(task, run('awaiting_approval', memory(false))), true);
    });

    it('does not notify a run nobody can open, or one that never ran', () => {
      assert.equal(shouldNotify(task, run('succeeded', memory(true), null)), false);
      assert.equal(shouldNotify(task, run('cancelled', memory(true))), false);
      assert.equal(shouldNotify(task, run('skipped', memory(true))), false);
    });

    it('behaves like "always" for a run that did not use memory', () => {
      // Memory was switched off for the installation (or the task) since the
      // owner chose this mode: there is no verdict to judge by.
      assert.equal(shouldNotify(task, run('succeeded')), true);
      assert.equal(shouldNotify(task, run('succeeded', { enabled: false, changed: false })), true);
      assert.equal(shouldNotify(task, run('failed')), true);
    });
  });
});

describe('newTaskDocument', () => {
  const build = fields =>
    newTaskDocument(
      { name: 'T', instructions: 'x', appId: 'digest', schedule: { type: 'manual' }, ...fields },
      { id: 'st-1', ownerId: 'o', owner: {}, now: Date.now(), staggerMinutes: 0 }
    );

  it('starts without memory and without a summary', () => {
    const task = build({});
    assert.deepEqual(task.memory, { enabled: false });
    assert.equal(task.memorySummary, null);
  });

  it('takes the setting from the validated fields', () => {
    assert.deepEqual(build({ memory: { enabled: true } }).memory, { enabled: true });
    assert.deepEqual(build({ memory: { enabled: 'yes' } }).memory, { enabled: false });
  });
});

describe('creating, editing and copying a task', () => {
  it('is off unless asked for', async () => {
    const task = await tasks.createTask(ada(), taskInput());
    assert.deepEqual(task.memory, { enabled: false });
    await cleanup(ada());
  });

  it('accepts a boolean or an object', async () => {
    const asBoolean = await tasks.createTask(ada(), taskInput({ name: 'a', memory: true }));
    const asObject = await tasks.createTask(
      ada(),
      taskInput({ name: 'b', memory: { enabled: true } })
    );
    const garbage = await tasks.createTask(ada(), taskInput({ name: 'c', memory: 'yes' }));
    assert.deepEqual(asBoolean.memory, { enabled: true });
    assert.deepEqual(asObject.memory, { enabled: true });
    assert.deepEqual(garbage.memory, { enabled: false });
    await cleanup(ada());
  });

  it('keeps the setting on an edit that does not name it, and changes it when named', async () => {
    const task = await tasks.createTask(ada(), taskInput({ memory: true }));
    const renamed = await tasks.updateTask(ada(), task.id, { name: 'Renamed' });
    assert.deepEqual(renamed.memory, { enabled: true });
    const off = await tasks.updateTask(ada(), task.id, { memory: false });
    assert.deepEqual(off.memory, { enabled: false });
    const on = await tasks.updateTask(ada(), task.id, { memory: { enabled: true } });
    assert.deepEqual(on.memory, { enabled: true });
    await cleanup(ada());
  });

  it('keeps tasks that were saved before memory existed off', async () => {
    const task = await tasks.createTask(ada(), taskInput());
    await getScheduledTaskRepository().mutateTask(task.id, stored => {
      delete stored.memory;
      delete stored.memorySummary;
      return stored;
    });
    const edited = await tasks.updateTask(ada(), task.id, { name: 'Still works' });
    assert.deepEqual(edited.memory, { enabled: false });
    const listed = await tasks.getTask(ada(), task.id);
    assert.equal(listed.name, 'Still works');
    await cleanup(ada());
  });

  it('copies the setting to a duplicate but not the notes', async () => {
    const task = await tasks.createTask(ada(), taskInput({ memory: true }));
    const stored = await getScheduledTaskRepository().getTask(task.id);
    await writeTaskMemory(stored, { content: 'the original knows this' });

    const copy = await tasks.duplicateTask(ada(), task.id);
    assert.deepEqual(copy.memory, { enabled: true });
    assert.equal(copy.memorySummary, null);
    const copyStored = await getScheduledTaskRepository().getTask(copy.id);
    const { getTaskMemoryRepository } =
      await import('../services/scheduler/tasks/TaskMemoryRepository.js');
    assert.equal((await getTaskMemoryRepository().get(copyStored.id)).version, 0);
    assert.equal((await getTaskMemoryRepository().get(task.id)).version, 1);
    await cleanup(ada());
  });
});

describe('notifying only when something changed', () => {
  const rejection = promise =>
    assert.rejects(promise, error => {
      assert.equal(error.status, 400);
      assert.ok(
        error.details.some(
          detail => detail.field === 'notify' && detail.code === 'NOTIFY_CHANGES_NEEDS_MEMORY'
        ),
        JSON.stringify(error.details)
      );
      return true;
    });

  it('needs memory when the task is created', async () => {
    await rejection(tasks.createTask(ada(), taskInput({ notify: 'changes' })));
    const ok = await tasks.createTask(ada(), taskInput({ notify: 'changes', memory: true }));
    assert.equal(ok.notify, 'changes');
    await cleanup(ada());
  });

  it('cannot be chosen by an edit that leaves memory off', async () => {
    const task = await tasks.createTask(ada(), taskInput());
    await rejection(tasks.updateTask(ada(), task.id, { notify: 'changes' }));
    const both = await tasks.updateTask(ada(), task.id, { notify: 'changes', memory: true });
    assert.equal(both.notify, 'changes');
    await cleanup(ada());
  });

  it('keeps memory switched on while this mode is chosen', async () => {
    const task = await tasks.createTask(ada(), taskInput({ notify: 'changes', memory: true }));
    await rejection(tasks.updateTask(ada(), task.id, { memory: false }));
    const both = await tasks.updateTask(ada(), task.id, { memory: false, notify: 'always' });
    assert.deepEqual(both.memory, { enabled: false });
    await cleanup(ada());
  });

  it('is listed among the valid modes when a bad one is refused', async () => {
    await assert.rejects(tasks.createTask(ada(), taskInput({ notify: 'sometimes' })), error =>
      /always, failure, never, changes/.test(error.message)
    );
  });
});

describe('platform settings', () => {
  it('ships defaults for the three new limits', () => {
    assert.equal(DEFAULT_SCHEDULED_TASK_SETTINGS.memoryEnabled, true);
    assert.equal(DEFAULT_SCHEDULED_TASK_SETTINGS.memoryMaxChars, 8000);
    assert.equal(DEFAULT_SCHEDULED_TASK_SETTINGS.maxHistoryReadChars, 8000);
  });

  it('fills them in when the platform file has none', () => {
    for (const platform of [undefined, {}, { scheduledTasks: {} }]) {
      const settings = scheduledTaskSettings(platform);
      assert.equal(settings.memoryEnabled, true);
      assert.equal(settings.memoryMaxChars, 8000);
      assert.equal(settings.maxHistoryReadChars, 8000);
    }
  });

  it('reads the admin values and clamps them into bounds', () => {
    const read = scheduledTasks => scheduledTaskSettings({ scheduledTasks });
    assert.equal(read({ memoryEnabled: false }).memoryEnabled, false);
    assert.equal(read({ memoryEnabled: 'no' }).memoryEnabled, true);
    assert.equal(read({ memoryMaxChars: 12000 }).memoryMaxChars, 12000);
    assert.equal(read({ memoryMaxChars: 10 }).memoryMaxChars, 1000);
    assert.equal(read({ memoryMaxChars: 10_000_000 }).memoryMaxChars, 64000);
    assert.equal(read({ memoryMaxChars: 'many' }).memoryMaxChars, 8000);
    assert.equal(read({ maxHistoryReadChars: 20000 }).maxHistoryReadChars, 20000);
    assert.equal(read({ maxHistoryReadChars: 5 }).maxHistoryReadChars, 1000);
    assert.equal(read({ maxHistoryReadChars: 10_000_000 }).maxHistoryReadChars, 50000);
  });

  it('tells the client whether memory is on and how long the notes may be', () => {
    const config = scheduledTasksClientConfig(configCache.getFeatures(), configCache.getPlatform());
    assert.equal(config.enabled, true);
    assert.equal(config.memoryEnabled, true);
    assert.equal(config.memoryMaxChars, 8000);
    assert.deepEqual(scheduledTasksClientConfig({ scheduledTasks: false }, {}), {
      enabled: false
    });
  });
});
