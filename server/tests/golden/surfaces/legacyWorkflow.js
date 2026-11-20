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
 * - `law-consultation-ifinder`: the shipped workflow
 *   `stellungnahmen-review-ifinder-v2` on a synthetic iFinder result set
 *   (`tests/fixtures/stellungnahmen/ifinder/`), answered by a stand-in for
 *   iFinder on the loopback interface (`ifinderStandIn.js`).
 * - `paused-and-resumed`: the shipped workflow `approval-workflow` pauses on its
 *   question to a person and continues with the answer.
 * - `resumed-after-restart`: an execution interrupted in a step is continued
 *   from its checkpoint by the sweep a starting server runs.
 * - `delivered-after-restart`: a workflow started from a chat waits for a
 *   person when its server dies. The chat is closed with "waiting for your
 *   input" when it is next read, the person answers, and the read after that
 *   puts the result into the chat (`deliverResumedWorkflows`).
 * - `trigger-started`: a workflow started by its webhook trigger.
 *
 * A restart is played inside the recording process: the engine is replaced by
 * a new one and, for the chat, what a dead process only knew is dropped
 * (`processDied`). No process is killed here: a test that kills a real server
 * belongs in the nightly tier (`server/tests/faults/`). The
 * sweep of a starting server is called as `startup/worker.js` calls it for a
 * plain workflow. That file does not export its wiring, so the options are
 * written again here (`startupSweep`), and a change to them there does not
 * show in these goldens.
 *
 * A run is started the way the product starts it: through the workflow runner
 * (the tool behind `workflow_<id>`, used by the chat and by the gateway), or
 * through the trigger manager. `result` holds what the starter got back and the
 * stored state of the execution.
 *
 * @module tests/golden/surfaces/legacyWorkflow
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mock } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byCodeUnit } from '../byCodeUnit.js';
import { defineCase } from '../harness.js';
import { turn } from '../../helpers/scriptedModel.js';
import { actionTracker } from '../../../actionTracker.js';
import interactionService from '../../../services/loop/InteractionService.js';
import { ingestInboundFiles, inboundChatId } from '../../../services/mcp/inboundFiles.js';
import memoryFile from '../../../agents/memory/memoryFile.js';
import integrationRegistry from '../../../services/integrations/definitions/IntegrationRegistry.js';
import iFinderSearchProfiles from '../../../services/integrations/iFinderSearchProfiles.js';
import iFinderService from '../../../services/integrations/iFinderService.js';
import { getContentsPath } from '../../../utils/contentsPath.js';
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
import workflowRunner, { activeWorkflowExecutions } from '../../../tools/workflowRunner.js';
import registerSessionRoutes from '../../../routes/chat/sessionRoutes.js';
import registerChatRoutes from '../../../routes/chats.js';
import { getLocalizedError } from '../../../serverHelpers.js';
import { getChatRepository } from '../../../services/chat/ChatRepository.js';
import { INTERRUPTED_RUN_GRACE_MS } from '../../../services/chat/chatRecovery.js';
import { RUN_LOG_EVENTS } from '../../../../shared/runEvents.js';
import {
  app,
  fixtureIntegrations,
  goldenUser,
  readStoredChat,
  surfaceConfig,
  usage,
  usersGroup
} from './fixtures.js';
import { recordAndRoute, recordedFrames } from './chat.js';
import { exchange, openRequest, startRouteServer } from './http.js';
import { readResultSet, startIFinderStandIn } from './ifinderStandIn.js';

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

/**
 * The config of a legacy case.
 *
 * @param {Object[]} workflows - `config/workflows.json`.
 * @param {Object} [options]
 * @param {Object[]} [options.apps] - Default: the app `desk`.
 * @param {Object} [options.permissions] - More permissions of the group `users`.
 * @param {Object} [options.platform] - More of `config/platform.json`.
 * @param {Object} [options.more] - Further keys of the config (`credentials`).
 * @returns {() => Object}
 */
const legacyConfig =
  (workflows, { apps = [app('desk')], permissions = {}, platform = {}, more = {} } = {}) =>
  () =>
    surfaceConfig({
      apps,
      features: { workflows: true },
      platform,
      groups: {
        users: usersGroup(
          apps.map(item => item.id),
          { workflows: ['*'], ...permissions }
        )
      },
      extra: {
        workflows,
        ...more,
        idPatterns: [
          // A stored file.
          /\bfile_([0-9a-f]{24})\b/g,
          // The chat a trigger names for its run: `trigger-<epoch ms>`.
          /\btrigger-(\d{10,})\b/g,
          // The chat of files that came in through the gateway.
          /\bmcp-golden-statements-([a-z0-9]{6})\b/g,
          // The port of a stand-in on the loopback interface.
          /\b127\.0\.0\.1:(\d{2,5})\b/g
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

/**
 * A model answer that waits until the ledger holds the answer of the person and the note that
 * the run was continued.
 *
 * The scripted model answers at once. A real one takes seconds, and the server has long stored
 * the answer of the person by then. Without the wait, the end of the run and the storing of the
 * answer race, and their order in the ledger differs from one recording to the next.
 *
 * @param {Object} env - The environment of the recording; the wait starts when the script is made.
 * @param {{respond: Function}} inner - The turn that answers (`turn.text(...)`).
 * @returns {(request: Object, ctx: Object) => Promise<Object>} A turn of a script.
 */
function afterTheAnswerIsStored(env, inner) {
  const stored = new Promise(resolve => {
    const unsubscribe = env.runLog.subscribeAll(event => {
      if (event.type !== RUN_LOG_EVENTS.RUN_RESUMED) return;
      unsubscribe();
      resolve();
    });
  });
  return async (request, ctx) => {
    await stored;
    return inner.respond(request, ctx);
  };
}

/**
 * Keep the answer of a person from being stored before the continued execution has asked the
 * model again.
 *
 * An answer continues its execution first and is stored after that
 * (`InteractionService.onAnswer`), so the first steps of the continued run and the storing of
 * the answer run side by side. With a real model the run is long at its model call when the
 * answer lands in the ledger. This handler makes that the order of every recording: it runs
 * after the handler that continues the execution, and returns when the model call has arrived
 * (or the execution ended without one, so that a failure does not wait forever). Together with
 * {@link afterTheAnswerIsStored} the ledger of a continued run has one order.
 *
 * Register it after `registerCheckpointResume()`.
 *
 * @param {Object} env - The environment of the recording.
 * @param {number} call - The number of the model call the continued execution makes.
 * @returns {() => void} unregister
 */
function storeTheAnswerAfterModelCall(env, call) {
  return interactionService.onAnswer(interaction =>
    Promise.race([
      env.model.waitForCall(call),
      executionEnded(interaction.source?.executionId || interaction.runId)
    ])
  );
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
  for (const name of fs.readdirSync(STATEMENTS_DIR).sort(byCodeUnit)) {
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

// ── the law consultation that reads from iFinder ─────────────────────────────

const IFINDER_WORKFLOW_ID = 'stellungnahmen-review-ifinder-v2';
/** The agent profile whose notes the workflow reads its map of the corpus from (start step). */
const IFINDER_AGENT_PROFILE = 'law-consultation-agent';
const IFINDER_KEY_REF = 'golden-ifinder-key';

let installationKeys = null;
/**
 * The key pair of the iFinder installation, made once per process: the private half is the
 * credential an admin stores for the installation, the public half is what iFinder checks a
 * token with. No key is kept in the repository.
 */
function ifinderKeys() {
  installationKeys ??= crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return installationKeys;
}

/** `config/integrations.json` with iFinder installed at `baseUrl`, as an admin sets it up. */
function integrationsWithIFinder(baseUrl) {
  const integrations = fixtureIntegrations();
  return {
    ...integrations,
    installed: [
      ...integrations.installed,
      {
        id: 'ifinder',
        definition: 'com.intrafind/ifinder',
        definitionVersion: integrationRegistry.get('com.intrafind/ifinder').definition.version,
        enabled: true,
        values: {
          baseUrl,
          authMode: 'ihubSigned',
          privateKeyRef: IFINDER_KEY_REF,
          defaultSearchProfile: 'searchprofile-standard'
        },
        auth: { mode: 'none' },
        actions: { enabled: ['*'], disabled: [], overrides: {} }
      }
    ]
  };
}

const ifinderConfig = () =>
  legacyConfig([shipped(IFINDER_WORKFLOW_ID)], {
    permissions: {
      integrations: ['lookup', 'archive', 'dangerous', 'tracker', 'ihub', 'ifinder']
    },
    // The stand-in is on the loopback interface: no proxy of the machine is asked for it.
    platform: { proxy: { enabled: false } },
    more: {
      credentials: {
        [IFINDER_KEY_REF]: { id: IFINDER_KEY_REF, type: 'secret', value: ifinderKeys().privateKey }
      }
    }
  })();

/** The notes of the agent: the section the workflow reads, and one it does not. */
const CORPUS_NOTES = [
  '## iFinder corpus map',
  '',
  '- Die Stellungnahmen zum MLNG liegen unter dem Label `bmg`.',
  '- Paragrafen werden als "§ 12 MLNG" geschrieben.',
  '',
  '## Other notes',
  '',
  '- Not part of the map.'
].join('\n');

/** The time limits the tool steps of a workflow set, in milliseconds. */
const toolStepLimits = workflow =>
  new Set(
    workflow.nodes
      .filter(node => node.type === 'tool' && Number.isFinite(node.config?.timeout))
      .map(node => node.config.timeout)
  );

/**
 * Run `fn` and clear the timers the tool steps left behind.
 *
 * A tool step of the legacy engine arms a timer for its time limit and does not clear it when
 * the tool answers (`ToolNodeExecutor.executeWithTimeout`, a frozen file). The timer of a step
 * that ended fires into nothing, but it keeps the process alive until then: ninety seconds for
 * a step of the law consultation. Only timers with exactly the delay of a tool step are cleared.
 *
 * @param {Set<number>} limits - {@link toolStepLimits}
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function clearingToolStepTimers(limits, fn) {
  const real = globalThis.setTimeout;
  const armed = [];
  const tracking = (callback, ms, ...args) => {
    const timer = real(callback, ms, ...args);
    if (limits.has(ms)) armed.push(timer);
    return timer;
  };
  Object.defineProperties(tracking, Object.getOwnPropertyDescriptors(real));
  globalThis.setTimeout = tracking;
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
    for (const timer of armed) clearTimeout(timer);
  }
}

/** The search plan the model makes from the focus and the map of the corpus. */
const SEARCH_PLAN = JSON.stringify({
  topics: ['Bezugsdauer § 12 MLNG', 'Meldefrist § 14 MLNG'],
  synonyms: { 'Bezugsdauer § 12 MLNG': ['Leistungsdauer', 'Befristung'] },
  entities: ['MLNG'],
  filters: {},
  expansions: ['Härtefallregelung']
});

/**
 * What the extraction step answers for each document that could be loaded, in the order the
 * workflow reads them: the order in which the searches first found them.
 */
const IFINDER_ANSWERS = [
  // bmg-st-0001
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
  // bmg-st-0002
  extraction({
    organisation: 'Musterkammer Nord',
    title: 'Stellungnahme der Musterkammer Nord',
    demandedChanges: [
      {
        paragraphReference: '§ 12 Abs. 3 MLNG',
        summary: 'Aufnahme einer Härtefallregelung',
        sourceQuote: 'Wir fordern jedoch, in § 12 Absatz 3 eine Härtefallregelung aufzunehmen.'
      }
    ]
  }),
  // bmg-st-0004
  extraction({
    organisation: 'Bündnis für Ärztinnen, Ärzte und Pflegekräfte',
    title: 'Änderungsvorschläge im Überblick',
    demandedChanges: [
      {
        paragraphReference: '§ 12 Abs. 2',
        summary: 'Beibehaltung der 78 Wochen',
        sourceQuote: 'Beibehaltung der 78 Wochen'
      }
    ],
    quotes: [{ text: 'Die Größe der Übergangsbeträge ist „unzureichend“' }]
  }),
  // bmg-st-0003, longer than the workflow reads: the model gets the first 50,000 characters.
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
  // bmg-st-0005, the scan: the index holds no text for it.
  extraction({ organisation: '', title: '' })
  // bmg-st-0006 cannot be loaded (404): the workflow skips it and no model is asked.
];

// ── a workflow of a chat, paused, and continued after a restart ──────────────

const RESTART_CHAT_ID = '0c0ffee0-0000-4000-8000-0000000e57a7';
const SSE = 'text/event-stream';

/** The shipped workflow with a question to a person, offered to chats as an admin offers it. */
const approvalWorkflowForChat = () => ({
  ...shipped('approval-workflow'),
  chatIntegration: { enabled: true, outputFormat: 'markdown' }
});

/** The node timeout a starting server gives a continued execution (`startup/worker.js`). */
const RESUME_NODE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The sweep a starting server runs for executions that were interrupted in a step
 * (`startup/worker.js`). This is the wiring of that file for a plain workflow, written again
 * here: the file does not export it.
 */
const startupSweep = env =>
  resumeInterruptedRuns({
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

/**
 * Whether two reads of a chat answered with the same status and the same messages. The chat
 * document beside them holds times that move with every read.
 */
const sameMessages = (a, b) =>
  a.response.status === b.response.status &&
  JSON.stringify(a.response.body?.messages) === JSON.stringify(b.response.body?.messages);

/**
 * Leave of a process what its death leaves: what it stored, and nothing it only knew.
 *
 * The recording stays in one process, so the state a dead process takes with it is dropped by
 * hand, piece by piece: the bridge between the workflow and its chat (`tools/workflowRunner.js`),
 * the run the ledger held open, and the engine with its executions. A test that kills a real
 * server belongs in the nightly tier (docs/run-testing.md).
 *
 * @param {Object} env
 * @param {Object} died
 * @param {string} died.chatId - The chat the workflow was bridged to.
 * @param {string} died.runId - The run of the workflow.
 * @param {Set<Function>} died.listenersBefore - The listeners of the action tracker before the
 *   workflow was started; the ones added since are the bridge.
 */
async function processDied(env, { chatId, runId, listenersBefore }) {
  for (const listener of actionTracker.listeners('fire-sse')) {
    if (!listenersBefore.has(listener)) actionTracker.off('fire-sse', listener);
  }
  activeWorkflowExecutions.delete(chatId);
  // What the ledger wrote is stored; that it held the run open is forgotten. There is no call
  // for this outside the ledger, because only the end of a process does it.
  await env.runLog.flush();
  env.runLog._drop(runId);
  resetWorkflowEngine();
}

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
    name: 'law-consultation-ifinder',
    title:
      'stellungnahmen-review-ifinder-v2 on a synthetic iFinder result set: a search plan from the notes of the agent, two rounds of search, one model call per document that could be loaded and a report from the records.',
    config: ifinderConfig,
    script: () => [
      turn.text(SEARCH_PLAN, { usage: usage(410, 60) }),
      // The first round: the model asks for one more topic. The second: the corpus is complete.
      turn.text(
        JSON.stringify({
          done: false,
          reason: 'Die Übergangsregelung fehlt.',
          extraTopics: ['Übergangsregelung § 20 MLNG']
        }),
        { usage: usage(520, 30) }
      ),
      turn.text(JSON.stringify({ done: true, reason: 'Der Korpus ist vollständig.' }), {
        usage: usage(540, 14)
      }),
      ...IFINDER_ANSWERS.map((answer, index) =>
        turn.text(answer, { usage: usage(900 + index, 120) })
      )
    ],
    run: async env => {
      resetWorkflowEngine();
      iFinderService.resetConfig();
      iFinderSearchProfiles.reset();
      const workflow = shipped(IFINDER_WORKFLOW_ID);
      // iFinder knows a user by the address in the token.
      const user = goldenUser(env, { email: 'golden.user@example.invalid' });
      const standIn = await startIFinderStandIn({
        resultSet: readResultSet(),
        publicKey: ifinderKeys().publicKey
      });
      const notes = getContentsPath('agents', 'memory', `${IFINDER_AGENT_PROFILE}.md`);
      try {
        env.configCache.setCacheEntry(
          'config/integrations.json',
          integrationsWithIFinder(standIn.baseUrl)
        );
        await memoryFile.writeMemory(IFINDER_AGENT_PROFILE, {
          content: CORPUS_NOTES,
          updatedBy: user.id
        });
        const started = await clearingToolStepTimers(toolStepLimits(workflow), () =>
          workflowRunner({
            workflowId: IFINDER_WORKFLOW_ID,
            chatId: 'golden-legacy-chat',
            user,
            input: 'Bezugsdauer und Meldefrist, § 12 und § 14 MLNG',
            language: 'de'
          })
        );
        return {
          result: {
            ifinder: { requests: standIn.requests },
            started,
            state: await executionState(started.executionId)
          }
        };
      } finally {
        await standIn.close();
        await fs.promises.rm(notes, { force: true });
        await fs.promises.rm(`${notes}.lock`, { force: true });
        iFinderService.resetConfig();
        iFinderSearchProfiles.reset();
      }
    }
  }),
  defineCase({
    surface: 'legacy-workflow',
    name: 'paused-and-resumed',
    title:
      'approval-workflow pauses on its question to a person; the answer continues the execution to its end.',
    config: legacyConfig([shipped('approval-workflow')]),
    script: env => [
      turn.text('1. Records are kept for ten years.\n2. Access is logged.', {
        usage: usage(120, 20)
      }),
      afterTheAnswerIsStored(
        env,
        turn.text('Records are kept for ten years and every access is logged.', {
          usage: usage(160, 14)
        })
      )
    ],
    run: async env => {
      resetWorkflowEngine();
      const user = goldenUser(env);
      // The server registers this when it starts (`startup/routes.js`).
      const unregister = registerCheckpointResume();
      const unregisterOrder = storeTheAnswerAfterModelCall(env, 2);
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
        unregisterOrder();
        if (typeof unregister === 'function') unregister();
      }
    }
  }),
  defineCase({
    surface: 'legacy-workflow',
    name: 'resumed-after-restart',
    title:
      'An execution that was interrupted in its second step is found by the sweep of a new engine and continued from its checkpoint. The sweep is called with the options startup/worker.js gives it for a plain workflow, written again in the test.',
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
      const sweep = await startupSweep(env);
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
    name: 'delivered-after-restart',
    title:
      'A workflow started from a chat waits for a person when its server dies. After the restart the chat says that it waits, the person answers, and the next read of the chat holds the result in the place of the waiting answer.',
    config: legacyConfig([approvalWorkflowForChat()], {
      apps: [app('desk', { workflows: ['approval-workflow'] })]
    }),
    script: env => [
      turn.text('1. Records are kept for ten years.\n2. Access is logged.', {
        usage: usage(120, 20)
      }),
      afterTheAnswerIsStored(
        env,
        turn.text('Records are kept for ten years and every access is logged.', {
          usage: usage(160, 14)
        })
      )
    ],
    run: async env => {
      resetWorkflowEngine();
      const user = goldenUser(env);
      const chatId = RESTART_CHAT_ID;
      const chatPath = `/api/apps/desk/chat/${chatId}`;
      const readPath = `/api/chats/${chatId}`;
      recordAndRoute(env);
      const startServer = () =>
        startRouteServer({
          user: () => user,
          register: expressApp => {
            registerSessionRoutes(expressApp, { getLocalizedError, DEFAULT_TIMEOUT: 60_000 });
            registerChatRoutes(expressApp);
          }
        });
      const listenersBefore = new Set(actionTracker.listeners('fire-sse'));
      // The server registers this when it starts (`startup/routes.js`).
      let unregister = registerCheckpointResume();
      let unregisterOrder = () => {};
      let server = await startServer();
      try {
        // The server that dies. The browser holds the stream of the chat and posts the mention.
        const stream = openRequest({
          port: server.port,
          method: 'GET',
          path: chatPath,
          headers: { accept: SSE }
        });
        await stream.until(frame => frame.data?.type === 'stream/connected', 'stream/connected');
        const raised = pausedOnInteraction(env);
        const posted = await exchange(server.port, {
          method: 'POST',
          path: chatPath,
          body: {
            messages: [
              { role: 'user', messageId: 'msg-1', content: '@approval-workflow Record keeping' }
            ],
            modelId: 'golden-model',
            language: 'en'
          }
        });
        const interaction = await raised;
        await stream.until(frame => frame.data?.type === 'run/paused', 'run/paused');
        await env.settle();
        const runId = interaction.runId;
        const waiting = await getChatRepository().getChat(chatId);

        stream.abort();
        const streamed = await stream.done;
        await server.close();
        unregister();
        await processDied(env, { chatId, runId, listenersBefore });
        const lastSeqBeforeRestart = env.ledger.findLast(event => event.runId === runId)?.seq;
        env.processRestarted();

        // The server that starts. Its sweep continues executions that were interrupted in a
        // step; one that waits for a person is not among them.
        unregister = registerCheckpointResume();
        unregisterOrder = storeTheAnswerAfterModelCall(env, 2);
        server = await startServer();
        const sweep = await startupSweep(env);
        // A turn that claimed its chat a moment ago is presumed alive, so the person comes back
        // later than that. The clock is moved for this one read: what the run does afterwards is
        // written with the time of the machine again, as the usage records are read by it.
        let firstRead;
        mock.timers.enable({ apis: ['Date'], now: Date.now() + INTERRUPTED_RUN_GRACE_MS + 60_000 });
        try {
          firstRead = await exchange(server.port, { method: 'GET', path: readPath });
        } finally {
          mock.timers.reset();
        }

        // The person answers on the page of the execution. This is the call the one answer
        // endpoint makes (`POST /api/runs/{runId}/interactions/{id}/answer`, `routes/runs.js`).
        const ended = executionEnded(runId);
        const answered = await interactionService.answer(
          interaction.id,
          { value: 'approve', data: { feedback: 'Keep it short.' } },
          { user, channel: 'api' }
        );
        const end = await ended;
        await env.settle();
        const secondRead = await exchange(server.port, { method: 'GET', path: readPath });
        // A third read finds nothing left to deliver.
        const thirdRead = await exchange(server.port, { method: 'GET', path: readPath });
        return {
          httpResponse: {
            beforeRestart: {
              post: posted,
              getStream: {
                request: { method: 'GET', path: chatPath, accept: SSE },
                response: {
                  status: streamed.status,
                  stream: recordedFrames(streamed.stream ?? [])
                }
              }
            },
            afterRestart: {
              firstRead,
              secondRead,
              thirdReadHasTheSameMessages: sameMessages(secondRead, thirdRead)
            }
          },
          result: {
            beforeRestart: {
              chat: { status: waiting?.status, runIsActive: waiting?.activeRunId === runId }
            },
            sweep,
            // The engine does not take up the sequence of the ledger when an answer continues an
            // execution it did not start (`WorkflowEngine.resume`): the run counts again from 1.
            ledgerSequence: {
              lastBeforeRestart: lastSeqBeforeRestart,
              firstAfterRestart: env.ledger
                .slice(env.ledgerRestarts.at(-1))
                .find(event => event.runId === runId)?.seq
            },
            answered: { status: answered?.status, answer: answered?.answer },
            ended: end.event,
            state: await executionState(runId)
          },
          ...(await readStoredChat(chatId))
        };
      } finally {
        unregisterOrder();
        unregister();
        await server.close();
        activeWorkflowExecutions.delete(chatId);
      }
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
