#!/usr/bin/env node

/**
 * Unit tests for the first-class living-plan upgrade to the agent dynamic-task
 * queue (`state.data._taskQueue`):
 *   - activeForm derivation on task records
 *   - the `set_plan` tool (declare/replace the whole plan)
 *   - the `update_task` tool and the single-in_progress invariant
 *
 * Plain-node test (matches the other server/tests/* agent tests, which avoids
 * the jest/uuid ESM transform issue). Run directly:
 *   `node server/tests/agent-living-plan.test.js`.
 */

import {
  buildTaskRecord,
  deriveActiveForm,
  enforceSingleInProgress
} from '../agents/runtime/taskRecord.js';
import agentTools from '../tools/agentTools.js';

const { setPlan, updateTask, createTask, listTasks } = agentTools;

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

function makeParams() {
  return {
    user: { isAgent: true, profileId: 'p1', id: 'agent:p1' },
    appConfig: {
      _agentProfile: { dynamicTasks: { enabled: true, maxDepth: 3 } },
      _workflowState: { executionId: 'exec1', data: { _taskQueue: [] } }
    },
    chatId: 'chat1'
  };
}

async function run() {
  console.log('🧪 deriveActiveForm\n');
  check('"Run tests" → "Running tests"', deriveActiveForm('Run tests') === 'Running tests');
  check(
    '"Write the report" → "Writing the report"',
    deriveActiveForm('Write the report') === 'Writing the report'
  );
  check('empty input → ""', deriveActiveForm('') === '' && deriveActiveForm(undefined) === '');

  console.log('\n🧪 buildTaskRecord\n');
  check('derives activeForm', buildTaskRecord({ title: 'Run tests' }).activeForm === 'Running tests');
  check(
    'honors explicit activeForm',
    buildTaskRecord({ title: 'Run tests', activeForm: 'Executing' }).activeForm === 'Executing'
  );
  check('defaults status to open', buildTaskRecord({ title: 'x' }).status === 'open');

  console.log('\n🧪 enforceSingleInProgress\n');
  {
    const queue = [
      { id: 'a', status: 'in_progress' },
      { id: 'b', status: 'in_progress' },
      { id: 'c', status: 'open' }
    ];
    const demoted = enforceSingleInProgress(queue, 'b');
    check('demotes other in_progress tasks', demoted.length === 1 && demoted[0] === 'a');
    check('keeps the chosen task in_progress', queue.find(t => t.id === 'b').status === 'in_progress');
    check('demoted task goes back to open', queue.find(t => t.id === 'a').status === 'open');
  }

  console.log('\n🧪 set_plan tool\n');
  {
    const params = makeParams();
    const res = await setPlan({ ...params, tasks: [{ title: 'Step one' }, { title: 'Step two' }] });
    const q = params.appConfig._workflowState.data._taskQueue;
    check('builds a fresh queue', res.ok === true && res.added === 2 && q.length === 2);
    check('all new tasks are open', q.every(t => t.status === 'open'));
  }
  {
    const params = makeParams();
    params.appConfig._workflowState.data._taskQueue = [
      buildTaskRecord({ title: 'Old done', status: 'done' })
    ];
    await setPlan({ ...params, tasks: [{ title: 'New step' }] });
    check(
      'preserves completed tasks by default',
      params.appConfig._workflowState.data._taskQueue.length === 2
    );
    await setPlan({ ...params, tasks: [{ title: 'Another' }], replaceCompleted: true });
    check(
      'replaceCompleted wipes prior tasks',
      params.appConfig._workflowState.data._taskQueue.length === 1
    );
  }
  {
    const params = makeParams();
    const res = await setPlan({ ...params, tasks: [] });
    check('rejects empty plan', res.error === true && res.code === 'INVALID_PLAN');
  }

  console.log('\n🧪 update_task tool\n');
  {
    const params = makeParams();
    await createTask({ ...params, title: 'First' });
    await createTask({ ...params, title: 'Second' });
    const q = params.appConfig._workflowState.data._taskQueue;
    await updateTask({ ...params, taskId: q[0].id, status: 'in_progress' });
    await updateTask({ ...params, taskId: q[1].id, status: 'in_progress' });
    const inProgress = q.filter(t => t.status === 'in_progress');
    check(
      'enforces single in_progress across the queue',
      inProgress.length === 1 && inProgress[0].id === q[1].id
    );

    const bad = await updateTask({ ...params, taskId: q[0].id, status: 'bogus' });
    check('rejects an unknown status', bad.error === true && bad.code === 'INVALID_STATUS');

    const missing = await updateTask({ ...params, taskId: 'nope', status: 'done' });
    check('returns NOT_FOUND for missing task', missing.error === true && missing.code === 'NOT_FOUND');
  }

  console.log('\n🧪 list_tasks still filters after upgrade\n');
  {
    const params = makeParams();
    await setPlan({ ...params, tasks: [{ title: 'One' }, { title: 'Two' }] });
    const q = params.appConfig._workflowState.data._taskQueue;
    await updateTask({ ...params, taskId: q[0].id, status: 'in_progress' });
    const res = await listTasks({ ...params, status: 'in_progress' });
    check('filters by status', res.tasks.length === 1);
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
