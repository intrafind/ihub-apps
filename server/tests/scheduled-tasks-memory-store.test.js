/**
 * The notes a scheduled task keeps between runs: the store's rules, what the
 * task document carries about them (a summary, never the content), what
 * happens to them when the task goes, and which principal may reach them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanup,
  principal,
  setPlatform,
  setupHarness,
  taskInput,
  teardownHarness
} from './helpers/scheduledTaskHarness.js';
import * as tasks from '../services/scheduler/tasks/taskService.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import {
  TaskMemoryError,
  getTaskMemoryRepository,
  nextBody
} from '../services/scheduler/tasks/TaskMemoryRepository.js';
import {
  clearTaskMemory,
  isMemoryOn,
  memorySettings,
  readTaskMemory,
  writeTaskMemory
} from '../services/scheduler/tasks/taskMemory.js';
import * as memoryService from '../services/memory/memoryService.js';

before(() => setupHarness());
after(() => teardownHarness());

const ada = () => principal({ id: 'user-ada', name: 'Ada' });

async function newTask(extra = { memory: { enabled: true } }) {
  const created = await tasks.createTask(ada(), taskInput(extra));
  return getScheduledTaskRepository().getTask(created.id);
}

async function expectMemoryError(promise, code, check = () => {}) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof TaskMemoryError, `a TaskMemoryError, got ${error?.name}`);
    assert.equal(error.code, code);
    check(error);
    return true;
  });
}

describe('nextBody', () => {
  it('follows the rules agent memory uses', () => {
    assert.equal(nextBody('', 'append', 'a'), 'a\n');
    assert.equal(nextBody('a\n\n\n', 'append', 'b'), 'a\nb\n');
    assert.equal(nextBody('old', 'replace', 'new'), 'new\n');
    assert.equal(nextBody('old', 'replace', 'new\n'), 'new\n');
  });

  it('leaves nothing when replaced with nothing, which is how notes are cleared', () => {
    assert.equal(nextBody('old\n', 'replace', ''), '');
  });

  it('rejects other modes', () => {
    assert.throws(() => nextBody('', 'prepend', 'x'), /Unsupported writeMemory mode/);
  });
});

describe('TaskMemoryRepository', () => {
  it('reads version 0 and an empty body for a task that never wrote notes', async () => {
    const task = await newTask();
    const doc = await getTaskMemoryRepository().get(task.id, task.ownerId);
    assert.equal(doc.version, 0);
    assert.equal(doc.body, '');
    assert.equal(doc.chars, 0);
    assert.equal(doc.updatedAt, null);
    await cleanup(ada());
  });

  it('creates the document on the first write and counts versions up', async () => {
    const task = await newTask();
    const repo = getTaskMemoryRepository();
    const first = await repo.write(task, { content: 'Reported up to v1', updatedBy: 'run:r1' });
    assert.equal(first.version, 1);
    assert.equal(first.body, 'Reported up to v1\n');
    assert.equal(first.chars, 18);
    assert.ok(first.updatedAt);

    const second = await repo.write(task, { mode: 'append', content: 'Follow up: docs' });
    assert.equal(second.version, 2);
    assert.equal(second.body, 'Reported up to v1\nFollow up: docs\n');

    const stored = await repo.get(task.id, task.ownerId);
    assert.equal(stored.version, 2);
    assert.equal(stored.updatedBy, 'system');
    assert.equal(stored.ownerId, task.ownerId);
    await cleanup(ada());
  });

  it('records who wrote and the optional summary', async () => {
    const task = await newTask();
    const repo = getTaskMemoryRepository();
    await repo.write(task, { content: 'x', updatedBy: 'compose:r7', summary: 'watermark' });
    const stored = await repo.get(task.id);
    assert.equal(stored.updatedBy, 'compose:r7');
    assert.equal(stored.summary, 'watermark');
    await cleanup(ada());
  });

  it('refuses a stale expectedVersion with the current version and changes nothing', async () => {
    const task = await newTask();
    const repo = getTaskMemoryRepository();
    await repo.write(task, { content: 'one' });
    await expectMemoryError(
      repo.write(task, { content: 'two', expectedVersion: 0 }),
      'VERSION_CONFLICT',
      error => {
        assert.equal(error.currentVersion, 1);
        assert.match(error.message, /expected 0, found 1/);
      }
    );
    assert.equal((await repo.get(task.id)).body, 'one\n');

    const matched = await repo.write(task, { content: 'two', expectedVersion: 1 });
    assert.equal(matched.version, 2);
    await cleanup(ada());
  });

  it('refuses notes over the limit and reports the size', async () => {
    const task = await newTask();
    const repo = getTaskMemoryRepository();
    await repo.write(task, { content: 'short', maxChars: 20 });
    await expectMemoryError(
      repo.write(task, { mode: 'append', content: 'x'.repeat(30), maxChars: 20 }),
      'MEMORY_TOO_LONG',
      error => {
        assert.equal(error.maxChars, 20);
        assert.equal(error.chars, 'short\n'.length + 31);
      }
    );
    assert.equal((await repo.get(task.id)).body, 'short\n');
    await cleanup(ada());
  });

  it('does not write for a task that does not exist, so a late write cannot bring notes back', async () => {
    const task = await newTask();
    const repo = getTaskMemoryRepository();
    await repo.write(task, { content: 'before' });
    await tasks.deleteTask(ada(), task.id);

    await expectMemoryError(repo.write(task, { content: 'late' }), 'TASK_NOT_FOUND');
    const keys = [];
    for await (const key of repo.keys()) keys.push(key);
    assert.ok(!keys.includes(task.id), 'no notes left for the deleted task');
  });

  it('rejects an id that is not a task id', async () => {
    await expectMemoryError(
      getTaskMemoryRepository().write({ id: '../escape' }, { content: 'x' }),
      'TASK_NOT_FOUND'
    );
    const doc = await getTaskMemoryRepository().get('../escape');
    assert.equal(doc.version, 0);
  });

  it('keeps every write when several arrive at once', async () => {
    const task = await newTask();
    const repo = getTaskMemoryRepository();
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map(content => repo.write(task, { mode: 'append', content }))
    );
    assert.deepEqual(results.map(result => result.version).sort(), [1, 2, 3, 4, 5]);
    const lines = (await repo.get(task.id)).body.trim().split('\n').sort();
    assert.deepEqual(lines, ['a', 'b', 'c', 'd', 'e']);
    await cleanup(ada());
  });
});

describe('the summary on the task document', () => {
  it('follows every write and carries no content', async () => {
    const task = await newTask();
    await writeTaskMemory(task, { content: 'secret watermark', updatedBy: 'run:r1' });
    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.memorySummary.version, 1);
    assert.equal(stored.memorySummary.chars, 'secret watermark\n'.length);
    assert.equal(stored.memorySummary.updatedBy, 'run:r1');
    assert.ok(stored.memorySummary.updatedAt);
    assert.ok(
      !JSON.stringify(stored).includes('secret watermark'),
      'the task document has no notes'
    );

    const publicTask = await tasks.getTask(ada(), task.id);
    assert.equal(publicTask.memorySummary.version, 1);
    assert.ok(!JSON.stringify(publicTask).includes('secret watermark'));
    const forAdmin = await tasks.adminGetTask(task.id);
    assert.ok(!JSON.stringify(forAdmin).includes('secret watermark'), 'admins never get the notes');
    assert.equal(forAdmin.memorySummary.chars, 'secret watermark\n'.length);
    await cleanup(ada());
  });

  it('never goes back to an older version when summary updates arrive out of order', async () => {
    const task = await newTask();
    await writeTaskMemory(task, { content: 'first', updatedBy: 'owner' });

    // A later write already landed its summary (version 5) when the summary of an
    // earlier write (version 2) reaches the task document.
    await getScheduledTaskRepository().mutateTask(task.id, stored => {
      stored.memorySummary = { ...stored.memorySummary, version: 5, updatedBy: 'compose:later' };
      return stored;
    });
    await writeTaskMemory(task, { content: 'second', updatedBy: 'run:earlier' });

    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.memorySummary.version, 5);
    assert.equal(stored.memorySummary.updatedBy, 'compose:later');
    await cleanup(ada());
  });

  it('is absent until the first write', async () => {
    const task = await newTask();
    assert.equal(task.memorySummary, null);
    await cleanup(ada());
  });
});

describe('clearTaskMemory', () => {
  it('empties the notes and still counts the version up', async () => {
    const task = await newTask();
    await writeTaskMemory(task, { content: 'notes' });
    const cleared = await clearTaskMemory(task, { updatedBy: 'admin' });
    assert.equal(cleared.version, 2);
    const doc = await readTaskMemory(task);
    assert.equal(doc.body, '');
    assert.equal(doc.version, 2);
    assert.equal(doc.updatedBy, 'admin');
    const stored = await getScheduledTaskRepository().getTask(task.id);
    assert.equal(stored.memorySummary.chars, 0);
    await cleanup(ada());
  });

  it('writes nothing when there was nothing to clear', async () => {
    const task = await newTask();
    assert.deepEqual(await clearTaskMemory(task), { version: 0 });
    assert.equal((await readTaskMemory(task)).version, 0);
    await cleanup(ada());
  });
});

describe('deleting a task', () => {
  it('deletes its notes and only its own', async () => {
    const mine = await newTask();
    const other = await newTask();
    await writeTaskMemory(mine, { content: 'mine' });
    await writeTaskMemory(other, { content: 'other' });

    await tasks.deleteTask(ada(), mine.id);
    assert.equal((await getTaskMemoryRepository().get(mine.id)).version, 0);
    assert.equal((await readTaskMemory(other)).body, 'other\n');
    await cleanup(ada());
  });

  it('is what an admin delete does too', async () => {
    const task = await newTask();
    await writeTaskMemory(task, { content: 'notes' });
    await tasks.adminDeleteTask(task.id);
    assert.equal((await getTaskMemoryRepository().get(task.id)).version, 0);
  });
});

describe('who gets a scope', () => {
  const inRun = (task, user = ada()) => ({
    ...user,
    scheduledRun: { taskId: task.id, runId: 'r-test' }
  });

  it('gives a run the notes of its own task when memory is on', async () => {
    const task = await newTask();
    assert.deepEqual(await memoryService.resolveMemoryScope(inRun(task)), {
      kind: 'scheduled-task',
      taskId: task.id,
      ownerId: task.ownerId
    });
    await cleanup(ada());
  });

  it('gives nothing when the task has memory off', async () => {
    const task = await newTask({ memory: { enabled: false } });
    assert.equal(await memoryService.resolveMemoryScope(inRun(task)), null);
    await cleanup(ada());
  });

  it('gives nothing when the installation switched memory off, and the notes stay', async () => {
    const task = await newTask();
    await writeTaskMemory(task, { content: 'kept' });
    setPlatform({ scheduledTasks: { memoryEnabled: false } });
    try {
      assert.equal(isMemoryOn(task, memorySettings()), false);
      assert.equal(await memoryService.resolveMemoryScope(inRun(task)), null);
      assert.equal((await readTaskMemory(task)).body, 'kept\n');
    } finally {
      setPlatform();
    }
    assert.ok(await memoryService.resolveMemoryScope(inRun(task)));
    await cleanup(ada());
  });

  it('gives nothing for an ordinary user, a run of a task that is gone, or a malformed run', async () => {
    assert.equal(await memoryService.resolveMemoryScope(ada()), null);
    assert.equal(
      await memoryService.resolveMemoryScope({
        ...ada(),
        scheduledRun: { taskId: 'st-00000000-0000-0000-0000-000000000000', runId: 'r' }
      }),
      null
    );
    assert.equal(await memoryService.resolveMemoryScope({ ...ada(), scheduledRun: {} }), null);
    assert.equal(
      await memoryService.resolveMemoryScope({ ...ada(), scheduledRun: { taskId: '../x' } }),
      null
    );
    await cleanup(ada());
  });
});

describe('the memory service on a task scope', () => {
  const scopeOf = task => ({ kind: 'scheduled-task', taskId: task.id, ownerId: task.ownerId });

  it('reads and writes like any memory', async () => {
    const task = await newTask();
    const scope = scopeOf(task);
    const written = await memoryService.writeMemory(scope, {
      mode: 'replace',
      content: 'watermark v2',
      updatedBy: 'run:r1'
    });
    assert.deepEqual(written, { version: 1, body: 'watermark v2\n', chars: 13 });
    const doc = await memoryService.readMemory(scope);
    assert.equal(doc.body, 'watermark v2\n');
    assert.equal(doc.version, 1);
    assert.equal(doc.updatedBy, 'run:r1');
    await cleanup(ada());
  });

  it('applies the platform size limit when the caller names none', async () => {
    const task = await newTask();
    setPlatform({ scheduledTasks: { memoryMaxChars: 1000 } });
    try {
      await expectMemoryError(
        memoryService.writeMemory(scopeOf(task), { content: 'x'.repeat(1500) }),
        'MEMORY_TOO_LONG',
        error => assert.equal(error.maxChars, 1000)
      );
      const ok = await memoryService.writeMemory(scopeOf(task), { content: 'x'.repeat(900) });
      assert.equal(ok.version, 1);
    } finally {
      setPlatform();
    }
    await cleanup(ada());
  });

  it('reads for a prompt: nothing for empty notes, whole up to twice the limit, then both ends', async () => {
    const task = await newTask();
    const scope = scopeOf(task);
    assert.equal(await memoryService.readMemoryForPrompt(scope, 100), null);
    await memoryService.writeMemory(scope, { content: '   \n' });
    assert.equal(await memoryService.readMemoryForPrompt(scope, 100), null);

    await memoryService.writeMemory(scope, { content: 'y'.repeat(50) });
    const whole = await memoryService.readMemoryForPrompt(scope, 100);
    assert.equal(whole.truncated, false);
    assert.equal(whole.version, 2);

    const whole2 = await memoryService.readMemoryForPrompt(scope, 30);
    assert.equal(whole2.truncated, false, 'over the limit, within twice it');
    assert.equal(whole2.chars, 51);

    await memoryService.writeMemory(scope, {
      mode: 'replace',
      content: `head${'y'.repeat(50)}tail`
    });
    const cut = await memoryService.readMemoryForPrompt(scope, 10);
    assert.equal(cut.truncated, true);
    assert.equal(cut.body, `heady${'y'.repeat(5)}\n\n[notes truncated]\n\n${'y'.repeat(5)}ytail`);
    await cleanup(ada());
  });

  it('refuses a scope whose owner is not the task owner', async () => {
    const task = await newTask();
    await expectMemoryError(
      memoryService.readMemory({
        kind: 'scheduled-task',
        taskId: task.id,
        ownerId: 'someone-else'
      }),
      'TASK_NOT_FOUND'
    );
    await cleanup(ada());
  });
});
