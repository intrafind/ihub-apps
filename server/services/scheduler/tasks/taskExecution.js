/**
 * One scheduled run: a new durable chat, one headless turn of the task's app
 * as the task's owner, and the record of how it went.
 *
 * The turn is an ordinary `ChatService.runTurn` — the same request builder,
 * agent loop, tool execution, usage tracking, telemetry, run ledger and chat
 * persistence as a turn typed in the chat UI. What a scheduled run adds:
 *
 *   - the principal is the owner, rebuilt and re-authorized on every run
 *     (`ownerPrincipal.js`), and the app, model and tools are checked against
 *     it explicitly — `prepareChatRequest` does not check the app;
 *   - the instructions get their run-context variables (`{{run_time}}` …);
 *   - the system prompt says that nobody is there to answer questions;
 *   - `ask_user` is refused (`headless`), and tools that need approval pause
 *     the run (`runSeams.js`);
 *   - the chat carries `origin: { createdVia: 'scheduled-task', taskId, runId }`
 *     and is marked unread when nobody watched it finish;
 *   - a task that keeps memory gets its notes in the system prompt, an
 *     instruction to read them and its earlier runs first, and (when the model
 *     can call tools) the tools to do so (`runMemory.js`).
 *
 * A run that paused for an approval is continued in the same chat once the
 * owner approves: a short message records the approval, and the approved
 * tool may run for the rest of that run.
 *
 * @module services/scheduler/tasks/taskExecution
 */
import crypto from 'node:crypto';
import configCache from '../../../configCache.js';
import { canUserAccessResource } from '../../../utils/authorization.js';
import { findByIdCaseInsensitive } from '../../../utils/resourceLookup.js';
import { getLocalizedError } from '../../../serverHelpers.js';
import logger from '../../../utils/logger.js';
import {
  abortChatRequest,
  markChatDurable,
  clearChatDurable,
  hasChatClient
} from '../../../sse.js';
import config from '../../../config.js';
import ChatService, { withAppPrompt } from '../../chat/ChatService.js';
import llmClient from '../../loop/LLMClient.js';
import { getChatRepository, normalizeChatSettings } from '../../chat/ChatRepository.js';
import { isChatPersistenceConfigured } from '../../chat/chatPersistence.js';
import interactionService from '../../loop/InteractionService.js';
import { newRunId as newLedgerRunId } from '../../loop/RunLog.js';
import { formatInstant, formatZonedIso } from '../schedule.js';
import { getScheduledTaskRepository, MAX_RUN_PAGE } from './ScheduledTaskRepository.js';
import {
  applyRunOutcome,
  holdTask,
  isFinalRunStatus,
  reasonOf,
  resolveRunContext,
  RUN_LEASE_MS,
  RUN_LEASE_RENEW_MS,
  runContextVariables
} from './taskModel.js';
import { resolveOwnerPrincipal } from './ownerPrincipal.js';
import { checkTaskPrincipal, SCHEDULED_TASK_ORIGIN, SCHEDULED_TASK_SOURCE } from './taskPolicy.js';
import { scheduledRunSeams } from './runSeams.js';
import { WITHHELD_IN_SCHEDULED_RUNS } from './toolGate.js';
import { isMemoryOn } from './taskMemory.js';
import { prepareRunMemory, settleMemoryMarker } from './runMemory.js';
import { composeTaskMemory, ownerMessagesAfterPreviousRun, sumUsage } from './memoryComposer.js';
import { announceTaskChanged } from './taskEvents.js';
import { currentPolicy, deleteRunChat, toolsOfferedByApp } from './taskService.js';

const COMPONENT = 'ScheduledTaskExecution';

/** Continuation turns one run may take (one per approval). */
const MAX_CONTINUATIONS = 5;

/** How many chats past the kept ones a trim looks at, for stragglers. */
const TRIM_LOOK_PAST = 20;

const UNATTENDED_NOTE =
  'Unattended run: this conversation was started by a scheduled task, and no user is ' +
  'available while it runs. Do not ask questions or wait for confirmation; make reasonable ' +
  'assumptions, state them briefly, and complete the task. The user will read the result later.';

let chatService = null;
function defaultChatService() {
  if (!chatService) chatService = new ChatService();
  return chatService;
}

/**
 * Tools that belong to an integration the owner has to be connected to,
 * checked before the run starts. Keyed by the tool's script.
 */
const INTEGRATION_CHECKS = {
  'jira.js': {
    label: 'Jira',
    connectPath: '/settings/integrations',
    async check(userId) {
      const { default: JiraService } = await import('../../integrations/JiraService.js');
      await JiraService.getUserTokens(userId);
    }
  }
};

/** The failure a run ends with. */
class RunFailure extends Error {
  constructor(status, code, message, { hold = null, extra = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.hold = hold;
    this.extra = extra;
  }
}

function appendSystemNote(llmMessages, note) {
  const system = llmMessages.find(message => message.role === 'system');
  if (system && typeof system.content === 'string') {
    if (!system.content.includes(note)) {
      system.content = system.content ? `${system.content}\n\n${note}` : note;
    }
    return;
  }
  llmMessages.unshift({ role: 'system', content: note });
}

function historyForPrompt(stored) {
  return (Array.isArray(stored) ? stored : [])
    .filter(entry => entry?.role && typeof entry.content === 'string' && entry.content.trim())
    .map(entry => ({ role: entry.role, content: entry.content }));
}

function runTitle(task, run, language) {
  const when = formatInstant(run.scheduledFor, task.schedule?.timezone || 'UTC', language);
  return `${task.name} · ${when}`.slice(0, 200);
}

/**
 * Check what the run needs, as the owner: the app, the model, the tools.
 *
 * @returns {Promise<{app: Object}>}
 * @throws {RunFailure}
 */
async function authorizeRun(task, user, language) {
  const { data: apps = [] } = configCache.getApps() || {};
  const app = findByIdCaseInsensitive(apps, task.appId);
  const pause = (code, message) =>
    new RunFailure('skipped', code, message, { hold: { status: 'paused', code, message } });
  if (!app || app.enabled === false) {
    throw pause('APP_NOT_AVAILABLE', `The app ${task.appId} no longer exists or is disabled`);
  }
  if (!canUserAccessResource(user, 'apps', app.id)) {
    throw pause('APP_NOT_ACCESSIBLE', `You no longer have access to the app ${task.appId}`);
  }
  if (task.modelId) {
    const { data: models = [] } = configCache.getModels() || {};
    const model = findByIdCaseInsensitive(models, task.modelId);
    if (!model || model.enabled === false) {
      throw pause('MODEL_NOT_AVAILABLE', `The model ${task.modelId} is no longer available`);
    }
    if (!canUserAccessResource(user, 'models', model.id)) {
      throw pause('MODEL_NOT_ACCESSIBLE', `You no longer have access to the model ${task.modelId}`);
    }
  }
  if (Array.isArray(task.enabledTools) && task.enabledTools.length > 0) {
    const offered = new Set((await toolsOfferedByApp(app, user, language)).map(tool => tool.id));
    const missing = task.enabledTools.filter(id => !offered.has(id));
    if (missing.length > 0) {
      throw pause('TOOL_NOT_AVAILABLE', `The app no longer offers: ${missing.join(', ')}`);
    }
  }
  return { app };
}

/**
 * Check the integrations the run's tools need, before spending a model call.
 *
 * @throws {RunFailure}
 */
async function checkIntegrations(tools, user) {
  const seen = new Set();
  for (const tool of tools) {
    const check = INTEGRATION_CHECKS[tool?.script];
    if (!check || seen.has(tool.script)) continue;
    seen.add(tool.script);
    try {
      await check.check(user.id);
    } catch {
      throw new RunFailure(
        'failed',
        'INTEGRATION_RECONNECT_REQUIRED',
        `Reconnect ${check.label}: the connection is missing or has expired`,
        { extra: { integration: check.label, connectUrl: check.connectPath } }
      );
    }
  }
}

/**
 * Execute one queued run to its end (or to an approval pause).
 *
 * @param {Object} params
 * @param {string} params.taskId
 * @param {string} params.runId
 * @param {Object} [deps] - Injectable for tests.
 * @param {Object} [deps.chatService]
 * @param {Object} [deps.repository]
 * @param {() => number} [deps.now]
 * @returns {Promise<Object|null>} The run as it ended, or null when there was nothing to run.
 */
export async function executeTaskRun({ taskId, runId }, deps = {}) {
  const repository = deps.repository || getScheduledTaskRepository();
  const service = deps.chatService || defaultChatService();
  const now = deps.now || (() => Date.now());
  const { settings, features, platform } = currentPolicy();
  const language = platform.defaultLanguage || 'en';

  const task = await repository.getTask(taskId);
  let run = await repository.getRun(taskId, runId);
  if (!task) {
    if (run && !isFinalRunStatus(run.status)) {
      await repository.mutateRun(taskId, runId, stored => ({
        ...stored,
        status: 'cancelled',
        finishedAt: new Date(now()).toISOString(),
        reason: reasonOf('TASK_DELETED', 'The task was deleted', now())
      }));
    }
    return null;
  }
  if (!run && task.activeRun?.id === runId) {
    // The claim stored the task but not the run: rebuild it from the claim.
    run = await repository.putRun({
      id: runId,
      taskId,
      ownerId: task.ownerId,
      taskName: task.name,
      runNumber: task.runNumber,
      trigger: task.activeRun.trigger,
      status: 'queued',
      scheduledFor: task.activeRun.scheduledFor,
      queuedAt: task.activeRun.queuedAt,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      chatId: task.activeRun.chatId,
      appId: task.appId,
      modelId: task.modelId || null,
      reason: null,
      usage: null,
      approval: null
    });
  }
  if (!run || run.status !== 'queued') return run || null;

  const continuation = run.continuation || null;
  const startedAtMs = now();
  // Whether this run uses the task's notes, and what it says about them. The
  // marker is stored on the run however it ends.
  const memoryOn = isMemoryOn(task, { enabled: settings.memoryEnabled });
  let memory = null;
  let memoryBefore = '';
  // This execution's fencing token. The run document carries it with a lease
  // this worker renews; a new scheduler owner recovers the run only once the
  // lease ran out, and a worker that finds its token gone writes nothing more.
  const token = crypto.randomUUID();
  let renewal = null;
  const stopRenewal = () => {
    if (renewal) clearInterval(renewal);
    renewal = null;
  };
  const leaseUntil = () => new Date(now() + RUN_LEASE_MS).toISOString();
  const finish = async (status, reason, extra = {}) => {
    stopRenewal();
    const endedAt = now();
    let written = false;
    const memoryMarker = memory ? await settleMemoryMarker(memory, task, runId) : null;
    const ended = await repository.mutateRun(taskId, runId, stored => {
      // Queued (it never started) or still ours: anything else means another
      // process settled this run — a recovery after this lease lapsed.
      const ours =
        stored.status === 'queued' ||
        (stored.status === 'running' && (!stored.execution || stored.execution.token === token));
      if (!ours) return null;
      written = true;
      return {
        ...stored,
        ...extra,
        ...(memoryMarker ? { memory: memoryMarker } : {}),
        status,
        reason,
        finishedAt: status === 'awaiting_approval' ? null : new Date(endedAt).toISOString(),
        durationMs: stored.startedAt ? endedAt - Date.parse(stored.startedAt) : null
      };
    });
    if (!written) {
      logger.warn('Scheduled run was settled elsewhere; its result is not stored', {
        component: COMPONENT,
        taskId,
        runId,
        status: ended?.status
      });
      return ended;
    }
    await repository.mutateTask(taskId, stored => {
      if (stored.activeRun?.id !== runId && status !== 'awaiting_approval') {
        // The task moved on (deleted and re-created, or an admin intervened);
        // still record the last run.
        stored.lastRun = { ...(stored.lastRun || {}), id: runId, status };
        return stored;
      }
      applyRunOutcome(stored, ended, {
        now: endedAt,
        settings,
        notify: !ended.watched
      });
      return stored;
    });
    announceTaskChanged(taskId);
    return ended;
  };

  // A run that was claimed and then saw its task paused or disabled before it
  // could start does not start. A manual run of a paused task does.
  if (task.status === 'disabled' || (task.status === 'paused' && run.trigger !== 'manual')) {
    return finish(
      'cancelled',
      reasonOf('TASK_NOT_ACTIVE', `The task was ${task.status} before the run started`, now())
    );
  }

  run = await repository.mutateRun(taskId, runId, stored => {
    if (stored.status !== 'queued') return null;
    return {
      ...stored,
      status: 'running',
      startedAt: stored.startedAt || new Date(startedAtMs).toISOString(),
      execution: { token, leaseUntil: leaseUntil() }
    };
  });
  // Another execution of the same claim got there first.
  if (run?.execution?.token !== token) return run || null;
  renewal = setInterval(() => {
    repository
      .mutateRun(taskId, runId, stored =>
        stored.status === 'running' && stored.execution?.token === token
          ? { ...stored, execution: { token, leaseUntil: leaseUntil() } }
          : null
      )
      .then(current => {
        if (current?.status === 'running' && current.execution?.token === token) return;
        // Recovered by a new scheduler owner while this worker was stalled:
        // stop the turn rather than keep acting on a run that is settled.
        stopRenewal();
        logger.warn('Scheduled run lost its lease; stopping it', {
          component: COMPONENT,
          taskId,
          runId
        });
        if (run.chatId) abortChatRequest(run.chatId);
      })
      .catch(error =>
        logger.warn('Could not renew a scheduled run lease', {
          component: COMPONENT,
          taskId,
          runId,
          error: error.message
        })
      );
  }, RUN_LEASE_RENEW_MS);
  renewal.unref?.();
  await repository.mutateTask(taskId, stored => {
    if (stored.activeRun?.id !== runId) return null;
    stored.activeRun = { ...stored.activeRun, status: 'running', startedAt: run.startedAt };
    return stored;
  });

  try {
    // Owner and permissions, re-resolved for this run.
    const owner = resolveOwnerPrincipal(task, { platform });
    if (!owner.ok) {
      const hold =
        owner.action === 'disable'
          ? { status: 'disabled', code: owner.code, message: owner.message }
          : null;
      throw new RunFailure(
        owner.action === 'retry' ? 'failed' : 'skipped',
        owner.code,
        owner.message,
        {
          hold
        }
      );
    }
    const user = owner.user;
    const principalCheck = checkTaskPrincipal(user);
    if (!principalCheck.ok) {
      throw new RunFailure(
        'skipped',
        'PERMISSION_REVOKED',
        'You are no longer allowed to run scheduled tasks',
        {
          hold: {
            status: 'paused',
            code: 'PERMISSION_REVOKED',
            message: 'You are no longer allowed to run scheduled tasks'
          }
        }
      );
    }
    // Only this run's own task may be changed from inside it; see the tools.
    user.scheduledRun = { taskId, runId };

    if (!isChatPersistenceConfigured(features, platform) || !getChatRepository().isAvailable()) {
      throw new RunFailure(
        'failed',
        'CHAT_STORAGE_UNAVAILABLE',
        'Chats cannot be stored right now'
      );
    }
    const { app } = await authorizeRun(task, user, language);

    // Messages: the instructions (first turn), or the stored conversation plus
    // the approval note (continuation).
    const chatRepository = getChatRepository();
    let content;
    let messages;
    if (continuation) {
      const approvedTool = continuation.approvedToolId || 'the requested tool';
      content = `Approved by ${user.name || user.username}: run ${approvedTool} and continue the task.`;
      const stored = await chatRepository.getMessages(run.chatId);
      messages = [...historyForPrompt(stored.messages), { role: 'user', content }];
    } else {
      const values = runContextVariables(task, run, { now: startedAtMs, format: formatZonedIso });
      content = resolveRunContext(task.instructions, values);
      messages = withAppPrompt(
        [{ role: 'user', content }],
        task.variables || {},
        app.prompt || null
      );
    }

    const prep = await service.prepareChatRequest({
      appId: app.id,
      modelId: task.modelId || undefined,
      messages,
      language,
      user,
      chatId: run.chatId,
      ...(Array.isArray(task.enabledTools) ? { enabledTools: task.enabledTools } : {}),
      ...(typeof task.websearchEnabled === 'boolean'
        ? { websearchEnabled: task.websearchEnabled }
        : {})
    });
    if (!prep.success) {
      const code = String(prep.error?.code || 'REQUEST_PREPARATION_FAILED');
      throw new RunFailure(
        'failed',
        code,
        prep.error?.message || 'The request could not be prepared'
      );
    }
    const prepared = prep.data;
    // Belt and braces: the tool gate already withholds these for a principal
    // carrying `scheduledRun`.
    prepared.tools = (prepared.tools || []).filter(
      tool => !WITHHELD_IN_SCHEDULED_RUNS.has(tool?.id)
    );
    appendSystemNote(prepared.llmMessages, UNATTENDED_NOTE);
    if (memoryOn) {
      const prepareMemory = await prepareRunMemory({
        task,
        run,
        prepared,
        language,
        continuation: Boolean(continuation),
        maxChars: settings.memoryMaxChars
      });
      for (const note of prepareMemory.notes) appendSystemNote(prepared.llmMessages, note);
      memory = prepareMemory.marker;
      memoryBefore = prepareMemory.before;
    }
    await checkIntegrations(prepared.tools, user);

    const allowedTools = new Set((task.allowedTools || []).map(entry => entry.toolId));
    if (continuation?.approvedToolId) allowedTools.add(continuation.approvedToolId);
    for (const id of run.approvedTools || []) allowedTools.add(id);
    const integrationIssues = [];
    const ledgerRunId = newLedgerRunId('chat');
    const seams = scheduledRunSeams({
      allowedTools,
      onIntegrationIssue: issue => integrationIssues.push(issue),
      raiseApproval: async (info, ctx) => {
        const expiresAt = new Date(now() + settings.approvalTimeoutHours * 3_600_000).toISOString();
        const interaction = await interactionService.raise({
          runId: ctx.runId || ledgerRunId,
          step: Number.isInteger(ctx.iteration) ? ctx.iteration : 0,
          kind: 'approval',
          origin: 'policy',
          prompt: {
            title: `Approve ${info.name || info.toolId}?`,
            message:
              `The scheduled task "${task.name}" wants to run ${info.name || info.toolId}. ` +
              'Approve it to let the run continue.',
            inputType: 'text',
            displayData: { toolId: String(info.toolId), args: info.args || {} }
          },
          policy: { expiresAt, onTimeout: 'fail', fallback: 'park' },
          source: {
            toolCallId: info.call?.id ? String(info.call.id) : undefined,
            toolId: String(info.toolId),
            chatId: run.chatId,
            appId: app.id,
            principalId: task.ownerId,
            identityMode: task.owner?.identityMode,
            scheduledTaskId: taskId,
            scheduledRunId: runId
          }
        });
        return interaction;
      }
    });

    const messageId = crypto.randomUUID();
    const buildLogData = (streaming, extra = {}) => ({
      messageId,
      appId: app.id,
      modelId: prepared.model?.id,
      sessionId: run.chatId,
      user,
      messages: prepared.llmMessages,
      options: {
        temperature: prepared.temperature,
        language,
        streaming,
        source: SCHEDULED_TASK_SOURCE,
        scheduledTaskId: taskId,
        scheduledRunId: runId
      },
      ...extra
    });
    const persistence = {
      repository: chatRepository,
      ownerId: task.ownerId,
      identityMode: task.owner?.identityMode || 'default',
      content,
      clientMessageId: null,
      settings: normalizeChatSettings({
        ...(Array.isArray(task.enabledTools) ? { enabledTools: task.enabledTools } : {}),
        ...(typeof task.websearchEnabled === 'boolean'
          ? { websearchEnabled: task.websearchEnabled }
          : {})
      }),
      ...(task.variables && !continuation ? { variables: task.variables } : {}),
      ...(continuation ? {} : { chat: { title: runTitle(task, run, language) } }),
      origin: {
        createdVia: SCHEDULED_TASK_ORIGIN,
        taskId,
        runId,
        taskName: task.name
      }
    };

    await service.logInteraction('chat_request', buildLogData(true));
    markChatDurable(run.chatId);
    let outcome;
    try {
      outcome = await service.runTurn({
        prep: prepared,
        chatId: run.chatId,
        messageId,
        streaming: true,
        headless: true,
        buildLogData,
        timeoutMs: config.REQUEST_TIMEOUT,
        getLocalizedError,
        language,
        user,
        runId: ledgerRunId,
        persistence,
        extraSeams: seams,
        trigger: { type: 'schedule', source: SCHEDULED_TASK_SOURCE },
        maxWallClockMs: settings.maxRunMinutes * 60_000,
        clientTimezone: task.schedule?.timezone || null
      });
    } finally {
      clearChatDurable(run.chatId);
    }
    const watched = hasChatClient(run.chatId);
    const ledgerRunIds = [...(run.ledgerRunIds || []), ledgerRunId];
    const usage = outcome.usage
      ? {
          promptTokens: outcome.usage.promptTokens || 0,
          completionTokens: outcome.usage.completionTokens || 0,
          totalTokens:
            outcome.usage.totalTokens ||
            (outcome.usage.promptTokens || 0) + (outcome.usage.completionTokens || 0)
        }
      : null;
    const addUsage = previous =>
      previous && usage
        ? {
            promptTokens: previous.promptTokens + usage.promptTokens,
            completionTokens: previous.completionTokens + usage.completionTokens,
            totalTokens: previous.totalTokens + usage.totalTokens
          }
        : usage || previous || null;

    if (outcome.status === 'paused' && outcome.pendingInteraction?.kind === 'approval') {
      const interaction = outcome.pendingInteraction;
      if ((run.continuations || 0) >= MAX_CONTINUATIONS) {
        await interactionService.cancel(interaction.id, 'cancelled').catch(() => {});
        return finish(
          'failed',
          reasonOf('TOO_MANY_APPROVALS', 'The run asked for approval too many times', now()),
          { ledgerRunIds, usage: addUsage(run.usage), watched }
        );
      }
      return finish(
        'awaiting_approval',
        reasonOf(
          'AWAITING_APPROVAL',
          `Waiting for your approval to run ${interaction.source?.toolId || 'a tool'}`,
          now()
        ),
        {
          ledgerRunIds,
          usage: addUsage(run.usage),
          watched,
          continuation: null,
          continuations: (run.continuations || 0) + 1,
          approvedTools: [...allowedTools].filter(
            id => !task.allowedTools?.some(a => a.toolId === id)
          ),
          approval: {
            interactionId: interaction.id,
            ledgerRunId,
            toolId: interaction.source?.toolId || null,
            args: interaction.prompt?.displayData?.args || {},
            requestedAt: interaction.createdAt,
            expiresAt: interaction.policy?.expiresAt || null,
            status: 'pending'
          }
        }
      );
    }
    if (outcome.status === 'aborted') {
      return finish('cancelled', reasonOf('ABORTED', 'The run was stopped', now()), {
        ledgerRunIds,
        usage: addUsage(run.usage),
        watched
      });
    }
    if (outcome.status === 'error') {
      const info = outcome.errorInfo || {};
      return finish(
        'failed',
        reasonOf(String(info.code || 'ERROR'), String(info.message || 'The run failed'), now()),
        { ledgerRunIds, usage: addUsage(run.usage), watched }
      );
    }
    if (integrationIssues.length > 0) {
      const issue = integrationIssues[0];
      return finish(
        'failed',
        reasonOf('INTEGRATION_RECONNECT_REQUIRED', issue.message, now(), {
          toolId: issue.toolId,
          ...(issue.connectUrl ? { connectUrl: issue.connectUrl } : {})
        }),
        { ledgerRunIds, usage: addUsage(run.usage), watched }
      );
    }
    // The run is done and good. The notes are brought up to date by one more
    // call that needs no tool, so this works on every model; it cannot change
    // how the run ended.
    let composedUsage = null;
    if (memory && memory.compose !== 'skipped' && Number.isInteger(memory.versionRead)) {
      const timezone = task.schedule?.timezone || 'UTC';
      const composed = await composeTaskMemory({
        llmClient: deps.llmClient || llmClient,
        task,
        run,
        user,
        model: prepared.model,
        ledgerRunId,
        instructions: resolveRunContext(
          task.instructions,
          runContextVariables(task, run, { now: startedAtMs, format: formatZonedIso })
        ),
        runTime: formatZonedIso(startedAtMs, timezone),
        notesBefore: memoryBefore,
        answer: outcome.content,
        ownerMessages: await ownerMessagesAfterPreviousRun(user, {
          taskId,
          currentRunId: runId
        }),
        maxChars: settings.memoryMaxChars
      });
      composedUsage = composed.usage;
      memory = {
        ...memory,
        changed: composed.changed,
        compose: composed.compose,
        ...(composed.usage ? { composeUsage: composed.usage } : {})
      };
      // The chat was marked unread when the answer landed, before anyone knew
      // there was nothing new in it. Someone who asked to hear only about
      // changes should not see an unread dot for a run that had none.
      if (task.notify === 'changes' && composed.changed === false) {
        await getChatRepository()
          .clearUnseen(run.chatId)
          .catch(error =>
            logger.warn('Could not clear the unread mark of a run without changes', {
              component: COMPONENT,
              taskId,
              runId,
              error: error.message
            })
          );
      }
    }
    return finish('succeeded', null, {
      ledgerRunIds,
      usage: sumUsage(addUsage(run.usage), composedUsage),
      watched
    });
  } catch (error) {
    const failure =
      error instanceof RunFailure
        ? error
        : new RunFailure('failed', 'INTERNAL_ERROR', error?.message || 'The run failed');
    if (!(error instanceof RunFailure)) {
      logger.error('Scheduled run crashed', {
        component: COMPONENT,
        taskId,
        runId,
        error: error?.message
      });
    }
    const ended = await finish(
      failure.status,
      reasonOf(failure.code, failure.message, now(), failure.extra)
    );
    if (failure.hold) {
      await repository.mutateTask(taskId, stored => {
        if (stored.status === 'disabled') return null;
        holdTask(
          stored,
          failure.hold.status,
          reasonOf(failure.hold.code, failure.hold.message, now())
        );
        return stored;
      });
      announceTaskChanged(taskId);
    }
    return ended;
  } finally {
    stopRenewal();
    await trimRunChats(taskId, settings.maxRunChatsPerTask, repository).catch(error =>
      logger.warn('Could not trim the run chats of a scheduled task', {
        component: COMPONENT,
        taskId,
        error: error.message
      })
    );
  }
}

/**
 * Keep the newest `keep` run chats of a task and delete the chats of older
 * runs, so a task that runs every quarter hour does not bury its owner's
 * chat history. The run records stay (without their chat) until the run
 * retention sweep removes them.
 *
 * @param {string} taskId
 * @param {number} keep - 0 keeps every chat.
 * @param {Object} repository
 * @returns {Promise<number>} Chats deleted.
 */
export async function trimRunChats(taskId, keep, repository = getScheduledTaskRepository()) {
  if (!keep || keep <= 0) return 0;
  // Older chats were trimmed by earlier runs, so a bounded look past the
  // limit is enough — but the limit itself may be larger than one page, and
  // runs without a chat (skipped slots) sit in between, so page until that
  // many chats were seen or the history ends.
  const lookAt = keep + TRIM_LOOK_PAST;
  let withChat = 0;
  let deleted = 0;
  let cursor = null;
  do {
    const page = await repository.listRuns(taskId, {
      limit: MAX_RUN_PAGE,
      ...(cursor ? { cursor } : {})
    });
    for (const run of page.items) {
      if (!run.chatId || run.chatDeleted || !run.startedAt) continue;
      withChat += 1;
      if (!isFinalRunStatus(run.status) || withChat <= keep) continue;
      await deleteRunChat(run.chatId);
      await repository.mutateRun(taskId, run.id, stored => ({ ...stored, chatDeleted: true }));
      deleted += 1;
    }
    cursor = page.nextCursor;
  } while (cursor && withChat < lookAt);
  return deleted;
}

export default executeTaskRun;
