/**
 * Deleting a user removes the tasks they own: a scheduled task is a standing
 * instruction to act as its owner, so it cannot outlive them. Run history and
 * notes go with it; other owners' tasks stay.
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
import { createTask, deleteTasksOfOwner } from '../services/scheduler/tasks/taskService.js';
import { getScheduledTaskRepository } from '../services/scheduler/tasks/ScheduledTaskRepository.js';
import { getTaskMemoryRepository } from '../services/scheduler/tasks/TaskMemoryRepository.js';
import { writeTaskMemory } from '../services/scheduler/tasks/taskMemory.js';

before(() => setupHarness());
after(() => teardownHarness());

const ada = () => principal({ id: 'user-ada', name: 'Ada' });
const bob = () => principal({ id: 'user-bob', name: 'Bob' });

describe('deleteTasksOfOwner', () => {
  it('removes every task of the owner with its notes, and no one else’s', async () => {
    const first = await createTask(ada(), taskInput({ name: 'first', memory: true }));
    const second = await createTask(ada(), taskInput({ name: 'second' }));
    const others = await createTask(bob(), taskInput({ name: 'bob’s' }));
    await writeTaskMemory(await getScheduledTaskRepository().getTask(first.id), {
      content: 'what the first one knows'
    });

    const result = await deleteTasksOfOwner(['user-ada']);

    assert.equal(result.tasks, 2);
    const repository = getScheduledTaskRepository();
    assert.equal(await repository.getTask(first.id), null);
    assert.equal(await repository.getTask(second.id), null);
    assert.equal((await getTaskMemoryRepository().get(first.id)).version, 0);
    assert.equal((await repository.getTask(others.id)).name, 'bob’s');
    await cleanup(bob());
  });

  it('removes the tasks filed under any of the ids it is given', async () => {
    const asId = await createTask(ada(), taskInput({ name: 'under the id' }));
    const asPseudonym = await createTask(
      principal({ id: 'usr_0123456789abcdef', name: 'Ada' }),
      taskInput({ name: 'under the pseudonym' })
    );

    const result = await deleteTasksOfOwner(['user-ada', 'usr_0123456789abcdef']);

    assert.equal(result.tasks, 2);
    assert.equal(await getScheduledTaskRepository().getTask(asId.id), null);
    assert.equal(await getScheduledTaskRepository().getTask(asPseudonym.id), null);
  });

  it('does nothing for an owner without tasks', async () => {
    assert.deepEqual(await deleteTasksOfOwner(['user-nobody']), {
      tasks: 0,
      chatsDeleted: 0
    });
  });
});
