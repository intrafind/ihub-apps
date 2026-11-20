// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The legacy workflow path: the engine that runs the old node types
 * (`WorkflowEngine.js` and `executors/**`, frozen by
 * `workflow-legacy-frozen.test.js`). These goldens pin its steps and its output
 * as they are, so that the new engine can be built beside it and every change
 * next to it shows. They compare nothing with a rebuild.
 *
 * - `law-consultation-upload`: the shipped workflow `stellungnahmen-review-v2`
 *   on the synthetic statements of `tests/fixtures/stellungnahmen/`.
 * - `paused-and-resumed`: the shipped workflow `approval-workflow` pauses on its
 *   question to a person and continues with the answer.
 * - `resumed-after-restart`: an execution interrupted in a step is continued
 *   from its checkpoint by the sweep a starting server runs.
 * - `trigger-started`: a workflow started by its webhook trigger.
 *
 * Not recorded here: the variant of the law consultation that reads from
 * iFinder, and the delivery of a continued workflow into its chat after a
 * restart (`deliverResumedWorkflows`). The first needs a recorded iFinder; the
 * second needs a process that really dies, because the bridge between a
 * workflow and its chat lives as long as the process does. docs/run-testing.md
 * lists both as open.
 *
 * A run is started the way the product starts it: through the workflow runner
 * (the tool behind `workflow_<id>`, used by the chat and by the gateway), or
 * through the trigger manager. `result` holds what the starter got back and the
 * stored state of the execution.
 *
 * @module tests/golden/surfaces/legacyWorkflow
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCase } from '../harness.js';
import { turn } from '../../helpers/scriptedModel.js';
import { actionTracker } from '../../../actionTracker.js';
import interactionService from '../../../services/loop/InteractionService.js';
import { ingestInboundFiles, inboundChatId } from '../../../services/mcp/inboundFiles.js';
import { registerCheckpointResume } from '../../../services/workflow/checkpointResume.js';
import { resumeInterruptedRuns } from '../../../services/workflow/resumeManager.js';
import {
  getWorkflowEngine,
  resetWorkflowEngine
} from '../../../services/workflow/WorkflowEngine.js';
import {
  getTriggerManager,
  resetTriggerManager
} from '../../../services/workflow/triggers/TriggerManager.js';
import { stopSchedulerLockHeartbeat } from '../../../services/workflow/triggers/schedulerLock.js';
import workflowRunner from '../../../tools/workflowRunner.js';
import { RUN_LOG_EVENTS } from '../../../../shared/runEvents.js';
import { app, goldenUser, surfaceConfig, usage, usersGroup } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../../..');
const STATEMENTS_DIR = path.join(REPO_ROOT, 'tests/fixtures/stellungnahmen');

/** A workflow as it ships (`server/defaults/workflows/<id>.json`). */
const shipped = id =>
  JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'server/defaults/workflows', `${id}.json`), 'utf8')
  );

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain'
};

/** A legacy workflow of two steps with a webhook trigger. */
const TRIGGERED_WORKFLOW = {
  id: 'golden-triggered',
  name: { en: 'Triggered summary' },
  description: { en: 'Summarises what a webhook sends' },
  version: '1.0.0',
  enabled: true,
  config: { maxExecutionTime: 60_000 },
  triggers: [{ id: 'hook', type: 'webhook', config: { secret: 'golden-secret' } }],
  nodes: [
    {
      id: 'start',
      type: 'start',
      config: { inputVariables: [{ name: 'event', type: 'string', required: true }] }
    },
    {
      id: 'summarise',
      type: 'prompt',
      name: { en: 'Summarise' },
      config: {
        system: { en: 'You summarise an event in one sentence.' },
        prompt: { en: 'Summarise this event: {{event}}' },
        outputVariable: 'summary'
      }
    },
    { id: 'end', type: 'end', config: { output: 'summary', outputVariables: ['summary'] } }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'summarise' },
    { id: 'e2', source: 'summarise', target: 'end' }
  ]
};

/** A legacy workflow of two prompt steps: what a restart interrupts between them. */
const TWO_STEP_WORKFLOW = {
  id: 'golden-two-steps',
  name: { en: 'Find and summarise' },
  description: { en: 'Finds the facts, then summarises them' },
  version: '1.0.0',
  enabled: true,
  config: { maxExecutionTime: 60_000 },
  nodes: [
    {
      id: 'start',
      type: 'start',
      config: { inputVariables: [{ name: 'topic', type: 'string', required: true }] }
    },
    {
      id: 'find',
      type: 'prompt',
      name: { en: 'Find' },
      config: {
        system: { en: 'You list the facts about a topic.' },
        prompt: { en: 'List the facts about: {{topic}}' },
        outputVariable: 'facts'
      }
    },
    {
      id: 'summarise',
      type: 'prompt',
      name: { en: 'Summarise' },
      config: {
        system: { en: 'You summarise facts in one sentence.' },
        prompt: { en: 'Summarise: {{facts}}' },
        outputVariable: 'summary'
      }
    },
    { id: 'end', type: 'end', config: { output: 'summary', outputVariables: ['summary'] } }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'find' },
    { id: 'e2', source: 'find', target: 'summarise' },
    { id: 'e3', source: 'summarise', target: 'end' }
  ]
};

/** The node timeout a starting server gives a continued execution (`startup/worker.js`). */
const RESUME_NODE_TIMEOUT_MS = 30 * 60 * 1000;

const legacyConfig = workflows => () =>
  surfaceConfig({
    apps: [app('desk')],
    features: { workflows: true },
    groups: { users: usersGroup(['desk'], { workflows: ['*'] }) },
    extra: {
      workflows,
      idPatterns: [
        // A stored file.
        /\bfile_([0-9a-f]{24})\b/g,
        // The chat a trigger names for its run: `trigger-<epoch ms>`.
        /\btrigger-(\d{10,})\b/g,
        // The chat of files that came in through the gateway.
        /\bmcp-golden-statements-([a-z0-9]{6})\b/g
      ],
      // The deadline of an execution is a point in time under a key that does not say so; the
      // options of a model call hold ids the server mints.
      volatileKeys: [
        '_executionDeadline',
        'configHash',
        '_humanWaitMs',
        // How long a step and the execution took.
        'duration',
        'totalDuration'
      ],
      // A prompt step tells the model the date in a sentence of its own.
      textRules: [
        {
          pattern: /Current date: [^(]+ \(timezone ([^)]+)\)/g,
          replace: 'Current date: <date> (timezone $1)'
        }
      ]
    }
  });

/** Resolves with the event that ends an execution, whichever way it ends. */
function executionEnded(executionId) {
  const ENDS = new Set(['workflow.complete', 'workflow.failed', 'workflow.cancelled']);
  return new Promise(resolve => {
    const handler = event => {
      if (!ENDS.has(event.event)) return;
      if (executionId && event.chatId !== executionId) return;
      actionTracker.off('fire-sse', handler);
      resolve(event);
    };
    actionTracker.on('fire-sse', handler);
  });
}

/**
 * Resolves with the interaction a run raised, once the run ledger says the run is paused: the
 * question is raised a moment before the pause is stored.
 */
function pausedOnInteraction(env) {
  return new Promise(resolve => {
    let interaction = null;
    const unsubscribe = env.runLog.subscribeAll(event => {
      if (event.type === RUN_LOG_EVENTS.INTERACTION_RAISED) interaction = event.data.interaction;
      if (event.type !== RUN_LOG_EVENTS.RUN_PAUSED || !interaction) return;
      unsubscribe();
      resolve(interaction);
    });
  });
}

/** The keys of the execution's data a golden holds: what the steps wrote, not the definition. */
const UNRECORDED_DATA = new Set(['_workflowDefinition', '_workflow', '_document', '_fileData']);

/** The stored state of an execution, as far as it says what the engine did. */
async function executionState(executionId) {
  const state = await getWorkflowEngine().getState(executionId);
  if (!state) return null;
  const data = {};
  for (const [key, value] of Object.entries(state.data ?? {})) {
    if (!UNRECORDED_DATA.has(key)) data[key] = value;
  }
  return {
    status: state.status,
    workflowId: state.workflowId,
    completedNodes: state.completedNodes,
    failedNodes: state.failedNodes,
    currentNodes: state.currentNodes,
    history: (state.history ?? []).map(entry => ({
      type: entry.type,
      nodeId: entry.nodeId,
      status: entry.status
    })),
    data
  };
}

/**
 * Bring the statements in as the product does for files that reach a workflow
 * through the gateway: each file is stored and read on its own, and a file that
 * cannot be read is refused.
 */
async function ingestStatements(user) {
  const chatId = inboundChatId('golden-statements');
  const documents = [];
  const refused = [];
  for (const name of fs.readdirSync(STATEMENTS_DIR).sort()) {
    const mimeType = MIME_TYPES[path.extname(name)];
    if (!mimeType) continue;
    const bytes = fs.readFileSync(path.join(STATEMENTS_DIR, name));
    try {
      const { fileData } = await ingestInboundFiles({
        files: [{ name, mimeType, bytes }],
        chatId,
        user,
        origin: 'mcp',
        message: { role: 'user', content: '' }
      });
      documents.push(...fileData);
    } catch (error) {
      refused.push({ name, code: error.code ?? null, message: error.message });
    }
  }
  return { documents, refused };
}

/** What the extraction step answers for one statement. */
const extraction = fields => JSON.stringify({ demandedChanges: [], quotes: [], ...fields });

const STATEMENT_ANSWERS = [
  extraction({
    organisation: 'Verband der Musterkassen',
    title: 'Stellungnahme zum Entwurf des MLNG',
    demandedChanges: [
      {
        paragraphReference: '§ 12 Abs. 2 MLNG',
        summary: 'Streichung der Begrenzung der Bezugsdauer auf 52 Wochen',
        sourceQuote:
          'Wir fordern, § 12 Absatz 2 zu streichen und die geltende Regelung beizubehalten.'
      },
      {
        paragraphReference: '§ 14 MLNG',
        summary: 'Verlängerung der Meldefrist auf zehn Tage',
        sourceQuote: 'Wir fordern, die Meldefrist in § 14 auf zehn Tage zu verlängern.'
      }
    ],
    quotes: [{ text: 'Die Bezugsdauer darf nicht auf 52 Wochen begrenzt werden.' }]
  }),
  extraction({
    organisation: 'Musterkammer Nord',
    title: 'Stellungnahme zum Entwurf des MLNG',
    demandedChanges: [
      {
        paragraphReference: '§ 12 Abs. 3 MLNG',
        summary: 'Aufnahme einer Härtefallregelung',
        sourceQuote: 'Wir fordern jedoch, in § 12 Absatz 3 eine Härtefallregelung aufzunehmen.'
      }
    ],
    quotes: [{ text: 'Die Kammer unterstützt die Befristung in § 12 Absatz 2 MLNG ausdrücklich.' }]
  }),
  // The scan: no text reached the model.
  extraction({ organisation: '', title: '' }),
  extraction({
    organisation: 'Arbeitsgemeinschaft Musterverbände',
    title: 'Stellungnahme zum Entwurf des MLNG, ausführliche Fassung',
    demandedChanges: [
      {
        paragraphReference: '§ 12 und § 14 MLNG',
        summary: 'Überarbeitung des Entwurfs',
        sourceQuote: 'Wir fordern insgesamt, den Entwurf in § 12 und § 14 zu überarbeiten.'
      }
    ]
  }),
  extraction({
    organisation: 'Bündnis für Ärztinnen, Ärzte und Pflegekräfte',
    title: 'Änderungsvorschläge im Überblick',
    demandedChanges: [
      {
        paragraphReference: '§ 12 Abs. 2',
        summary: 'Beibehaltung der 78 Wochen',
        sourceQuote: 'Beibehaltung der 78 Wochen'
      },
      {
        paragraphReference: '§ 20',
        summary: 'Übergang 18 Monate, zusätzlich Härtefälle',
        sourceQuote: 'Übergang 18 Monate, zusätzlich Härtefälle'
      }
    ],
    quotes: [{ text: 'Die Größe der Übergangsbeträge ist „unzureichend“' }]
  })
];

export const legacyWorkflowCases = [
  defineCase({
    surface: 'legacy-workflow',
    name: 'law-consultation-upload',
    title:
      'stellungnahmen-review-v2 on six synthetic statements: one model call per readable document and a report from the records.',
    config: legacyConfig([shipped('stellungnahmen-review-v2')]),
    script: () =>
      STATEMENT_ANSWERS.map((answer, index) =>
        turn.text(answer, { usage: usage(900 + index, 120) })
      ),
    run: async env => {
      resetWorkflowEngine();
      const user = goldenUser(env);
      const { documents, refused } = await ingestStatements(user);
      const started = await workflowRunner({
        workflowId: 'stellungnahmen-review-v2',
        chatId: 'golden-legacy-chat',
        user,
        input: 'Bezugsdauer und Meldefrist, § 12 und § 14 MLNG',
        _fileData: documents,
        language: 'de'
      });
      return {
        result: {
          statements: {
            read: documents.map(document => ({
              name: document.fileName,
              type: document.fileType,
              characters: (document.content ?? '').length,
              pageImages: document.pageImages?.length ?? 0
            })),
            refused
          },
          started,
          state: await executionState(started.executionId)
        }
      };
    }
  }),
  defineCase({
    surface: 'legacy-workflow',
    name: 'paused-and-resumed',
    title:
      'approval-workflow pauses on its question to a person; the answer continues the execution to its end.',
    config: legacyConfig([shipped('approval-workflow')]),
    script: () => [
      turn.text('1. Records are kept for ten years.\n2. Access is logged.', {
        usage: usage(120, 20)
      }),
      turn.text('Records are kept for ten years and every access is logged.', {
        usage: usage(160, 14)
      })
    ],
    run: async env => {
      resetWorkflowEngine();
      const user = goldenUser(env);
      // The server registers this when it starts (`startup/routes.js`).
      const unregister = registerCheckpointResume();
      try {
        const raised = pausedOnInteraction(env);
        const running = workflowRunner({
          workflowId: 'approval-workflow',
          chatId: 'golden-legacy-chat',
          user,
          input: 'Record keeping',
          language: 'en'
        });
        const interaction = await raised;
        const paused = await executionState(interaction.runId);
        const answered = await interactionService.answer(
          interaction.id,
          { value: 'approve', data: { feedback: 'Keep it short.' } },
          { user, channel: 'chat' }
        );
        const started = await running;
        return {
          result: {
            paused: { status: paused?.status, currentNodes: paused?.currentNodes },
            answered: { status: answered?.status, answer: answered?.answer },
            started,
            state: await executionState(started.executionId)
          }
        };
      } finally {
        if (typeof unregister === 'function') unregister();
      }
    }
  }),
  defineCase({
    surface: 'legacy-workflow',
    name: 'resumed-after-restart',
    title:
      'An execution that was interrupted in its second step is found by the sweep of a new engine and continued from its checkpoint.',
    config: legacyConfig([TWO_STEP_WORKFLOW]),
    script: () => [
      turn.text('Records are kept for ten years. Access is logged.', { usage: usage(40, 10) }),
      // The model call the old process was waiting for when it died: it never answers.
      turn.hang(),
      turn.text('Records are kept ten years with logged access.', { usage: usage(52, 9) })
    ],
    run: async env => {
      resetWorkflowEngine();
      const user = goldenUser(env);
      const started = await getWorkflowEngine().start(
        TWO_STEP_WORKFLOW,
        { topic: 'Record keeping', _workflowDefinition: TWO_STEP_WORKFLOW },
        { user, checkpointOnNode: true }
      );
      const executionId = started.executionId;
      await env.model.waitForCall(2);
      const interrupted = await executionState(executionId);

      // The restart: the engine of the old process is gone, with whatever it was waiting for.
      // Only the stored state is left. A new engine sweeps for interrupted executions, as the
      // server does when it starts (`startup/worker.js`).
      resetWorkflowEngine();
      const ended = executionEnded(executionId);
      const sweep = await resumeInterruptedRuns({
        engine: getWorkflowEngine(),
        // A plain workflow is continued as the system user, with the node timeout of a resume.
        resolveDefinition: async state => ({
          definition: env.configCache.getWorkflowById(state.workflowId),
          options: {
            user: { id: 'system', name: 'System (resumed)', groups: [] },
            timeout: RESUME_NODE_TIMEOUT_MS
          }
        }),
        requireSchedulerOwner: false,
        heldByAnotherWorker: () => false
      });
      const end = await ended;
      return {
        result: {
          interrupted: {
            status: interrupted?.status,
            completedNodes: interrupted?.completedNodes,
            currentNodes: interrupted?.currentNodes
          },
          sweep,
          ended: end.event,
          state: await executionState(executionId)
        }
      };
    }
  }),
  defineCase({
    surface: 'legacy-workflow',
    name: 'trigger-started',
    title: 'A workflow started by its webhook trigger runs as the system user to its end.',
    config: legacyConfig([TRIGGERED_WORKFLOW]),
    script: () => [turn.text('The printer on floor 3 is on fire.', { usage: usage(40, 9) })],
    run: async env => {
      resetWorkflowEngine();
      resetTriggerManager();
      const manager = getTriggerManager();
      try {
        // What the server does when it starts (`startup/worker.js`).
        manager.setEngine(getWorkflowEngine());
        manager.setWorkflowLoader(async () => env.configCache.getWorkflows().data);
        manager.registerWorkflowTriggers(TRIGGERED_WORKFLOW);
        const ended = executionEnded();
        // What the webhook route does once the signature of the request is verified.
        await manager.fireTrigger(TRIGGERED_WORKFLOW.id, {
          id: 'hook',
          type: 'webhook',
          initialData: { event: 'Smoke alarm in the printer room on floor 3.' }
        });
        const end = await ended;
        return {
          result: {
            registered: manager.getActiveTriggers(),
            ended: end.event,
            state: await executionState(end.chatId)
          }
        };
      } finally {
        manager.unregisterAll();
        stopSchedulerLockHeartbeat();
        resetTriggerManager();
      }
    }
  })
];
