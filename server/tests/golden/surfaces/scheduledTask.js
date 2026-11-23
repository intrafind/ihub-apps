// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The scheduled task surface: a task is created and a run is requested through
 * the task service, as the routes do it, and the run is executed by
 * `executeTaskRun`, the function the scheduler calls for a queued run.
 *
 * `result` holds the run as it ended and the task's notes; `storedMessage` and
 * `evidence` hold the chat of the run.
 *
 * @module tests/golden/surfaces/scheduledTask
 */
import { defineCase } from '../harness.js';
import { turn } from '../../helpers/scriptedModel.js';
import interactionService from '../../../services/loop/InteractionService.js';
import * as tasks from '../../../services/scheduler/tasks/taskService.js';
import { executeTaskRun } from '../../../services/scheduler/tasks/taskExecution.js';
import {
  app,
  goldenUser,
  readStoredChat,
  surfaceConfig,
  usage,
  usersGroup,
  withoutContentHashes
} from './fixtures.js';
import { RUN_CHAT_TITLE_RULE } from './textRules.js';

const APPS = [
  app('digest', {
    system: { en: 'You write digests.' },
    integrations: { lookup: {}, dangerous: {} }
  })
];

/**
 * A workflow an app offers to its model as a tool. No group of this fixture grants it
 * (`permissions.workflows`), so it is offered to one kind of owner only: an administrator, by
 * the rule "an admin sees every workflow" (`filterByPermissions` in
 * `services/workflow/workflowAccess.js`, asked by `getToolsForApp` for every `app.workflows`).
 */
const INSTALLATION_CHECK = Object.freeze({
  id: 'installation-check',
  name: { en: 'Installation check' },
  description: { en: 'Checks the installation and reports what it found' },
  version: '1.0.0',
  enabled: true,
  chatIntegration: { enabled: true },
  config: { allowCycles: false, maxIterations: 5 },
  nodes: [
    { id: 'start', type: 'start', name: { en: 'Start' }, position: { x: 0, y: 0 }, config: {} },
    { id: 'end', type: 'end', name: { en: 'End' }, position: { x: 0, y: 100 }, config: {} }
  ],
  edges: [{ id: 'e1', source: 'start', target: 'end' }]
});

const taskConfig = () =>
  surfaceConfig({
    apps: [
      ...APPS,
      // The group of a plain user does not list it; the group of the admins lists every app.
      // It lists a workflow that no group grants: see `admin-owner`.
      app('operations', {
        system: { en: 'You report on the installation.' },
        workflows: [INSTALLATION_CHECK.id]
      })
    ],
    features: { scheduledTasks: true, workflows: true },
    platform: {
      scheduledTasks: { staggerMinutes: 0, minIntervalMinutes: 15, maxTasksPerUser: 10 }
    },
    groups: {
      users: usersGroup(['digest'], { scheduledTasks: true }),
      admins: {
        id: 'admins',
        permissions: {
          apps: ['*'],
          models: ['*'],
          prompts: [],
          integrations: [],
          scheduledTasks: true,
          adminAccess: true
        }
      }
    },
    extra: {
      workflows: [INSTALLATION_CHECK],
      // A run: `r<epoch ms>-<random>`.
      idPatterns: [/\b(r\d{10,}-[0-9a-f]{8})\b/g],
      // The prompt of a run holds the time of the run, so a hash over the request does too.
      volatileKeys: ['configHash'],
      // The chat of a run is named after the task and the time of the run.
      textRules: [RUN_CHAT_TITLE_RULE]
    }
  });

const taskInput = (extra = {}) => ({
  name: 'Release watch',
  instructions: 'Report the state of record A-1. Run {{run_number}}.',
  appId: 'digest',
  schedule: { type: 'daily', time: '08:00', timezone: 'Europe/Berlin' },
  ...extra
});

/** The reply of the composer that keeps the notes of a task: whether something changed, and the notes. */
const composerReply = (notes, changed = true) =>
  `<changed>${changed ? 'yes' : 'no'}</changed>\n<notes>\n${notes}\n</notes>`;

/**
 * Create a task, request a run and execute it.
 *
 * @param {Object} env
 * @param {Object} options
 * @param {Object} [options.task] - Fields of the task beside the defaults.
 * @param {Object} [options.owner] - Fields of the owner beside those of the golden user.
 * @param {(ctx: Object) => Promise<void>} [options.before] - Runs after the task is created.
 * @param {(ctx: Object) => Promise<void>} [options.after] - Runs after the first execution.
 */
async function runTask(env, { task: fields = {}, owner = {}, before, after } = {}) {
  const user = goldenUser(env, owner);
  // The scheduler registers this when the server starts (`services/scheduler/index.js`).
  const unregister = interactionService.onAnswer(interaction =>
    tasks.applyApprovalAnswer(interaction)
  );
  try {
    const task = await tasks.createTask(user, taskInput(fields));
    const ctx = { env, user, task, runs: [] };
    await before?.(ctx);
    const queued = await tasks.requestRun(user, task.id);
    ctx.runId = queued.id;
    ctx.runs.push(await executeTaskRun({ taskId: task.id, runId: queued.id }));
    await after?.(ctx);
    await env.settle();
    const run = await tasks.getRun(user, task.id, queued.id);
    const notes = await tasks.getTaskMemory(user, task.id).catch(error => ({
      error: error.code ?? error.message
    }));
    const chat = run?.chatId ? await readStoredChat(run.chatId) : {};
    if (chat.evidence) chat.evidence = withoutContentHashes(chat.evidence);
    return {
      result: {
        executions: ctx.runs,
        run,
        task: await tasks.getTask(user, task.id),
        notes
      },
      ...chat
    };
  } finally {
    unregister();
  }
}

export const scheduledTaskCases = [
  defineCase({
    surface: 'scheduled-task',
    name: 'plain',
    title: 'A run without tools: the answer is stored in the chat of the run.',
    config: taskConfig,
    script: () => [turn.text('Record A-1 is open.', { usage: usage(60, 6) })],
    run: env => runTask(env)
  }),
  defineCase({
    surface: 'scheduled-task',
    name: 'tool',
    title: 'A run with a tool call: the tool runs as the owner of the task.',
    config: taskConfig,
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: usage(60, 8) }),
      turn.text('Record A-1 is open.', { usage: usage(82, 6) })
    ],
    run: env => runTask(env)
  }),
  defineCase({
    surface: 'scheduled-task',
    name: 'notes-injection',
    title:
      'A task that keeps notes: the notes of earlier runs are part of the prompt, and the tools for notes and earlier runs are offered.',
    config: taskConfig,
    script: () => [
      turn.text('Record A-1 is still open.', { usage: usage(140, 7) }),
      // The composer that brings the notes up to date after the run.
      turn.text(composerReply('- A-1 was open on the first run.', false), { usage: usage(90, 20) })
    ],
    run: env =>
      runTask(env, {
        task: { memory: { enabled: true } },
        before: ({ user, task }) =>
          tasks.setTaskMemory(user, task.id, { content: '- A-1 was open on the first run.' })
      })
  }),
  defineCase({
    surface: 'scheduled-task',
    name: 'memory-composer',
    title:
      'After a run the composer writes the notes of the task; the run records that they changed.',
    config: taskConfig,
    script: () => [
      turn.text('Record A-1 is open.', { usage: usage(120, 6) }),
      turn.text(composerReply('- A-1 is open.'), { usage: usage(80, 16) })
    ],
    run: env => runTask(env, { task: { memory: { enabled: true } } })
  }),
  defineCase({
    surface: 'scheduled-task',
    name: 'admin-owner',
    title:
      'The run of a task whose owner is an admin: nobody is there, so the run has the rights of the groups of the owner and none of an administrator, and the model is not offered the workflow of the app that no group of the owner grants. The run the row "unattended-admin-rights" of the difference list is about.',
    config: taskConfig,
    script: () => [turn.text('The installation is healthy.', { usage: usage(50, 6) })],
    run: env =>
      runTask(env, {
        owner: { id: 'golden-admin', name: 'Golden Admin', groups: ['admins'] },
        task: { appId: 'operations', instructions: 'Report on the installation.' }
      })
  }),
  defineCase({
    surface: 'scheduled-task',
    name: 'approval-denied-headless',
    title:
      'A run without a person calls a tool that needs approval: the run waits, the owner refuses, and the run ends cancelled without another model call.',
    config: taskConfig,
    script: () => [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: usage(60, 8) })
    ],
    run: env =>
      runTask(env, {
        after: async ctx => {
          const { user, task, runId } = ctx;
          ctx.answered = await tasks.answerApproval(user, task.id, runId, { decision: 'reject' });
          // Executing the run again changes nothing: the refusal ended it.
          ctx.runs.push(await executeTaskRun({ taskId: task.id, runId }));
        }
      })
  })
];
