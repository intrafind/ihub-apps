/**
 * The scheduled task and run documents, and every state transition on them,
 * as pure functions.
 *
 * Nothing here reads storage, the clock or configuration: callers pass `now`
 * and the settings in. That keeps the rules — when a slot runs, when it is
 * skipped, when a task completes or pauses itself — testable without a
 * scheduler, and identical whichever process applies them.
 *
 * Task statuses:
 *   active    runs on its schedule
 *   paused    by the owner, an admin, or itself (lost access, repeated failures)
 *   completed nothing left to run (a one-time task fired, end date or max runs reached)
 *   disabled  cannot run any more (owner deleted or deactivated, or an admin)
 *
 * Run statuses: queued, running, awaiting_approval, succeeded, failed,
 * skipped, cancelled.
 *
 * @module services/scheduler/tasks/taskModel
 */
import { randomUUID } from 'node:crypto';
import { nextSlot, slotsBetween, staggerOffsetMs, parseInstant } from '../schedule.js';
import { newRunId } from './ScheduledTaskRepository.js';

export const TASK_SCHEMA_VERSION = 1;
export const TASK_STATUSES = Object.freeze(['active', 'paused', 'completed', 'disabled']);
export const RUN_STATUSES = Object.freeze([
  'queued',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'cancelled'
]);
export const FINAL_RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'skipped', 'cancelled']);
export const RUN_TRIGGERS = Object.freeze(['schedule', 'manual', 'catch-up']);
/**
 * When the owner is told about a run: after every one (`always`), only a failed
 * one (`failure`), never, or only when something changed (`changes`: a failed
 * run, or a run that reported something new — it needs memory, because
 * "something new" is judged against the notes).
 */
export const NOTIFY_MODES = Object.freeze(['always', 'failure', 'never', 'changes']);

/** A slot found later than this is treated as missed, not as merely late. */
export const LATE_GRACE_MS = 10 * 60_000;
/** Unseen run notifications kept per task. */
export const MAX_UNSEEN_RUNS = 20;
/**
 * How long an executing run's lease lasts without renewal. The worker running
 * it renews it well within that; one that stopped renewing is taken for dead.
 */
export const RUN_LEASE_MS = 3 * 60_000;
/** How often the executing worker renews its lease. */
export const RUN_LEASE_RENEW_MS = 45_000;

/**
 * Whether a `running` run is still held by a live worker — its execution lease
 * has not run out. A run without one (never started under a lease) is not.
 *
 * @param {Object|null} run
 * @param {number} now - ms
 * @returns {boolean}
 */
export function runLeaseHeld(run, now) {
  const until = Date.parse(run?.execution?.leaseUntil || '');
  return Number.isFinite(until) && until > now;
}

/**
 * Whether a run status is final.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isFinalRunStatus(status) {
  return FINAL_RUN_STATUSES.includes(status);
}

/**
 * The next run of a task after `after`: the nominal slot and the staggered
 * start. Both null when the task will not run on its own again.
 *
 * @param {Object} task
 * @param {Object} options
 * @param {number} options.after - ms
 * @param {number} [options.staggerMinutes=0]
 * @returns {{nextSlotAt: string|null, nextRunAt: string|null}}
 */
export function computeNextRun(task, { after, staggerMinutes = 0 }) {
  const slot = nextSlot(task.schedule, { after, runCount: task.scheduledRunCount || 0 });
  if (!slot) return { nextSlotAt: null, nextRunAt: null };
  const offset = staggerOffsetMs(task.id, staggerMinutes);
  return {
    nextSlotAt: slot.toISOString(),
    nextRunAt: new Date(slot.getTime() + offset).toISOString()
  };
}

/**
 * A new task document.
 *
 * @param {Object} fields - Validated fields (name, instructions, appId, schedule …).
 * @param {Object} options
 * @param {string} options.id
 * @param {string} options.ownerId - Owner principal id.
 * @param {Object} options.owner - Owner snapshot.
 * @param {number} options.now - ms
 * @param {number} options.staggerMinutes
 * @param {string} [options.createdVia='ui']
 * @param {Object} [options.extra] - `proposalId`, `sourceChatId`, …
 * @returns {Object}
 */
export function newTaskDocument(
  fields,
  { id, ownerId, owner, now, staggerMinutes, createdVia = 'ui', extra = {} }
) {
  const iso = new Date(now).toISOString();
  const task = {
    id,
    schemaVersion: TASK_SCHEMA_VERSION,
    ownerId,
    owner,
    name: fields.name,
    description: fields.description || '',
    instructions: fields.instructions,
    appId: fields.appId,
    modelId: fields.modelId || null,
    variables: fields.variables || null,
    enabledTools: Array.isArray(fields.enabledTools) ? fields.enabledTools : null,
    websearchEnabled: typeof fields.websearchEnabled === 'boolean' ? fields.websearchEnabled : null,
    memory: { enabled: fields.memory?.enabled === true },
    memorySummary: null,
    schedule: fields.schedule,
    notify: fields.notify || 'always',
    status: 'active',
    statusReason: null,
    allowedTools: [],
    nextSlotAt: null,
    nextRunAt: null,
    activeRun: null,
    lastRun: null,
    runNumber: 0,
    scheduledRunCount: 0,
    consecutiveFailures: 0,
    lastRunAt: null,
    lastSuccessfulRunAt: null,
    unseenRuns: [],
    createdAt: iso,
    updatedAt: iso,
    createdVia,
    ...extra
  };
  Object.assign(task, computeNextRun(task, { after: now, staggerMinutes }));
  if (task.schedule.type !== 'manual' && !task.nextRunAt) {
    task.status = 'completed';
    task.statusReason = reasonOf('NO_FUTURE_RUNS', 'The schedule has no future runs', now);
  }
  return task;
}

/**
 * A status reason.
 *
 * @param {string} code
 * @param {string} message
 * @param {number} now
 * @param {Object} [extra]
 * @returns {{code: string, message: string, at: string}}
 */
export function reasonOf(code, message, now, extra = {}) {
  return { code, message, at: new Date(now).toISOString(), ...extra };
}

/**
 * A new run document.
 *
 * @param {Object} task
 * @param {Object} options
 * @param {string} options.trigger - schedule | manual | catch-up
 * @param {string} options.status
 * @param {number} options.now
 * @param {string|null} [options.scheduledFor]
 * @param {Object|null} [options.reason]
 * @param {Object} [options.extra]
 * @returns {Object}
 */
export function newRunDocument(
  task,
  { trigger, status, now, scheduledFor = null, reason = null, extra = {} }
) {
  const iso = new Date(now).toISOString();
  const executes = status === 'queued';
  return {
    id: newRunId(now),
    taskId: task.id,
    ownerId: task.ownerId,
    taskName: task.name,
    runNumber: executes ? (task.runNumber || 0) + 1 : null,
    trigger,
    status,
    scheduledFor: scheduledFor || iso,
    queuedAt: iso,
    startedAt: null,
    finishedAt: status === 'queued' ? null : iso,
    durationMs: null,
    chatId: executes ? randomUUID() : null,
    appId: task.appId,
    modelId: task.modelId || null,
    reason,
    usage: null,
    approval: null,
    ...extra
  };
}

/** The `activeRun` summary a task carries for a run in flight. */
export function activeRunOf(run) {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    scheduledFor: run.scheduledFor,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt || null,
    chatId: run.chatId || null
  };
}

/** The `lastRun` summary a task carries for its most recent run. */
export function lastRunOf(run) {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    chatId: run.chatId || null,
    reason: run.reason || null
  };
}

/**
 * Queue a run on a task: bump its counters and mark it busy.
 *
 * @param {Object} task - Mutated.
 * @param {Object} run - A `queued` run of this task.
 * @returns {Object} The task.
 */
export function attachQueuedRun(task, run) {
  task.runNumber = (task.runNumber || 0) + 1;
  if (run.trigger !== 'manual') task.scheduledRunCount = (task.scheduledRunCount || 0) + 1;
  task.activeRun = activeRunOf(run);
  return task;
}

/**
 * Decide what a due task does now: run its slot, skip it, or record the slots
 * a stopped scheduler missed — and where its schedule goes next.
 *
 *   - A slot found within {@link LATE_GRACE_MS} of its start runs (`schedule`).
 *   - A slot found later was missed. The most recent missed slot runs once
 *     (`catch-up`) when it is inside the catch-up window; the others are
 *     recorded as one `skipped` run with the count.
 *   - A slot that comes while the previous run is still in flight is skipped.
 *
 * @param {Object} task - Stored task (not mutated).
 * @param {Object} options
 * @param {number} options.now - ms
 * @param {Object} options.settings - Scheduled task settings.
 * @returns {{task: Object, runs: Object[], queued: Object|null}|null} Null when the task is not
 *   due (or not active). `runs` are the run documents to store (the queued one included).
 */
export function planDueSlot(task, { now, settings }) {
  if (!task || task.status !== 'active' || !task.nextRunAt) return null;
  const dueAt = Date.parse(task.nextRunAt);
  if (!Number.isFinite(dueAt) || dueAt > now) return null;
  const next = structuredClone(task);
  const runs = [];
  let queued = null;
  const stagger = staggerOffsetMs(task.id, settings.staggerMinutes);
  const slotAt = Date.parse(task.nextSlotAt) || dueAt - stagger;

  let runSlot = null;
  let trigger = 'schedule';
  if (now - dueAt <= LATE_GRACE_MS) {
    runSlot = slotAt;
  } else {
    // Every slot from the one that was due up to now was missed.
    const { slots, truncated } = slotsBetween(task.schedule, {
      from: slotAt - 1,
      to: now,
      runCount: task.scheduledRunCount || 0,
      limit: 10_000
    });
    const missed = slots.length > 0 ? slots.map(s => s.getTime()) : [slotAt];
    const latest = missed.at(-1);
    const windowMs = (settings.catchUpWindowHours || 0) * 3_600_000;
    const catchUp = windowMs > 0 && now - (latest + stagger) <= windowMs;
    const skippedCount = catchUp ? missed.length - 1 : missed.length;
    if (catchUp) {
      runSlot = latest;
      trigger = 'catch-up';
    }
    if (skippedCount > 0) {
      runs.push(
        newRunDocument(next, {
          trigger: 'schedule',
          status: 'skipped',
          now,
          scheduledFor: new Date(missed[0]).toISOString(),
          reason: reasonOf(
            'MISSED',
            skippedCount === 1
              ? 'This run was missed while the scheduler was not running'
              : `${skippedCount}${truncated ? '+' : ''} runs were missed while the scheduler was not running`,
            now
          ),
          extra: { missedSlots: skippedCount }
        })
      );
      // Missed slots still count toward `maxRuns`: "five times, then stop"
      // means five slots, not five successes.
      next.scheduledRunCount = (next.scheduledRunCount || 0) + skippedCount;
    }
  }

  if (runSlot !== null) {
    const scheduledFor = new Date(runSlot).toISOString();
    if (next.activeRun) {
      runs.push(
        newRunDocument(next, {
          trigger,
          status: 'skipped',
          now,
          scheduledFor,
          reason: reasonOf('PREVIOUS_RUN_ACTIVE', 'The previous run was still running', now)
        })
      );
      next.scheduledRunCount = (next.scheduledRunCount || 0) + 1;
    } else {
      queued = newRunDocument(next, { trigger, status: 'queued', now, scheduledFor });
      attachQueuedRun(next, queued);
      runs.push(queued);
    }
  }

  const skipped = runs.filter(run => run.status === 'skipped');
  if (skipped.length > 0 && !queued) next.lastRun = lastRunOf(skipped.at(-1));

  Object.assign(
    next,
    computeNextRun(next, {
      after: Math.max(now, runSlot ?? slotAt),
      staggerMinutes: settings.staggerMinutes
    })
  );
  if (!next.nextRunAt && !queued && !next.activeRun) {
    // Nothing left to run and nothing in flight: the schedule is exhausted.
    completeTask(next, now, skipped.length > 0 ? 'MISSED' : 'NO_FUTURE_RUNS');
  }
  return { task: next, runs, queued };
}

/**
 * Mark a task completed.
 *
 * @param {Object} task - Mutated.
 * @param {number} now
 * @param {string} [code='NO_FUTURE_RUNS']
 */
export function completeTask(task, now, code = 'NO_FUTURE_RUNS') {
  const messages = {
    NO_FUTURE_RUNS: 'The schedule has no more runs',
    MISSED: 'The last scheduled run was missed',
    MAX_RUNS: 'The maximum number of runs was reached',
    ONCE: 'The one-time run has happened'
  };
  task.status = 'completed';
  task.statusReason = reasonOf(code, messages[code] || messages.NO_FUTURE_RUNS, now);
  task.nextSlotAt = null;
  task.nextRunAt = null;
}

/**
 * Put a task on hold with a reason.
 *
 * @param {Object} task - Mutated.
 * @param {'paused'|'disabled'} status
 * @param {Object} reason - {@link reasonOf}
 */
export function holdTask(task, status, reason) {
  task.status = status;
  task.statusReason = reason;
  task.nextSlotAt = null;
  task.nextRunAt = null;
}

/**
 * Make a task active again: clear its hold and compute its next run from now,
 * so slots that passed while it was on hold are not caught up.
 *
 * @param {Object} task - Mutated.
 * @param {Object} options
 * @param {number} options.now
 * @param {number} options.staggerMinutes
 * @returns {Object} The task.
 */
export function resumeTask(task, { now, staggerMinutes }) {
  task.status = 'active';
  task.statusReason = null;
  task.consecutiveFailures = 0;
  Object.assign(task, computeNextRun(task, { after: now, staggerMinutes }));
  if (task.schedule?.type !== 'manual' && !task.nextRunAt) completeTask(task, now);
  return task;
}

/**
 * Whether a finished run should notify its owner.
 *
 * @param {Object} task
 * @param {Object} run
 * @returns {boolean}
 */
export function shouldNotify(task, run) {
  // "Only when something changed" is judged against the task's notes, so a run
  // that did not use them (memory off, or switched off for the installation
  // since) is treated as `always`.
  const mode = task.notify === 'changes' && run.memory?.enabled !== true ? 'always' : task.notify;
  if (mode === 'never') return false;
  if (run.status === 'awaiting_approval') return true;
  if (!run.chatId) return false;
  if (mode === 'failure') return run.status === 'failed';
  if (mode === 'changes') {
    // An unknown verdict (`changed` is null) counts as a change: a missed
    // report costs more than one notification too many.
    return run.status === 'failed' || (run.status === 'succeeded' && run.memory.changed !== false);
  }
  return run.status === 'succeeded' || run.status === 'failed';
}

/**
 * Record a notification for a run the owner has not seen.
 *
 * @param {Object} task - Mutated.
 * @param {Object} run
 */
export function addUnseenRun(task, run) {
  const list = Array.isArray(task.unseenRuns) ? task.unseenRuns.filter(e => e.id !== run.id) : [];
  list.unshift({
    id: run.id,
    chatId: run.chatId || null,
    status: run.status,
    finishedAt: run.finishedAt || new Date().toISOString()
  });
  task.unseenRuns = list.slice(0, MAX_UNSEEN_RUNS);
}

/**
 * Apply the end of a run to its task: counters, last run, notification,
 * completion, and the auto-pause after repeated failures.
 *
 * @param {Object} task - Mutated.
 * @param {Object} run - The run in its final (or awaiting-approval) state.
 * @param {Object} options
 * @param {number} options.now
 * @param {Object} options.settings
 * @param {boolean} [options.notify=true] - Whether the owner might not have seen the result.
 * @returns {Object} The task.
 */
export function applyRunOutcome(task, run, { now, settings, notify = true }) {
  if (run.status === 'awaiting_approval') {
    if (task.activeRun?.id === run.id) task.activeRun.status = 'awaiting_approval';
    if (notify && shouldNotify(task, run)) addUnseenRun(task, run);
    return task;
  }
  if (task.activeRun?.id === run.id) task.activeRun = null;
  task.lastRun = lastRunOf(run);
  if (run.status !== 'skipped' && run.startedAt) task.lastRunAt = run.startedAt;
  if (run.status === 'succeeded') {
    task.lastSuccessfulRunAt = run.startedAt || run.finishedAt;
    task.consecutiveFailures = 0;
  } else if (run.status === 'failed') {
    task.consecutiveFailures = (task.consecutiveFailures || 0) + 1;
  }
  if (notify && shouldNotify(task, run)) addUnseenRun(task, run);

  if (task.status === 'active') {
    const max = settings.maxConsecutiveFailures || 0;
    if (run.status === 'failed' && max > 0 && task.consecutiveFailures >= max) {
      holdTask(
        task,
        'paused',
        reasonOf(
          'TOO_MANY_FAILURES',
          `Paused after ${task.consecutiveFailures} failed runs in a row`,
          now,
          { lastError: run.reason?.message || null }
        )
      );
    } else if (!task.nextRunAt && task.schedule?.type !== 'manual') {
      const code =
        task.schedule?.type === 'once'
          ? 'ONCE'
          : Number.isInteger(task.schedule?.maxRuns) &&
              (task.scheduledRunCount || 0) >= task.schedule.maxRuns
            ? 'MAX_RUNS'
            : 'NO_FUTURE_RUNS';
      completeTask(task, now, code);
    }
  }
  return task;
}

/**
 * The run-context variables a task's instructions may use.
 *
 * @param {Object} task
 * @param {Object} run
 * @param {Object} options
 * @param {number} options.now
 * @param {(instant: *, timezone: string) => string} options.format - ISO with offset.
 * @returns {Object<string, string>}
 */
export function runContextVariables(task, run, { now, format }) {
  const tz = task.schedule?.timezone || 'UTC';
  const fmt = value => (value ? format(value, tz) : '');
  return {
    task_name: task.name,
    run_time: fmt(now),
    scheduled_time: fmt(run.scheduledFor),
    run_number: String(run.runNumber ?? ''),
    run_trigger: run.trigger,
    last_run_at: fmt(task.lastRunAt),
    last_successful_run_at: fmt(task.lastSuccessfulRunAt),
    timezone: tz
  };
}

/** Variables {@link resolveRunContext} replaces. */
export const RUN_CONTEXT_VARIABLES = Object.freeze([
  'task_name',
  'run_time',
  'scheduled_time',
  'run_number',
  'run_trigger',
  'last_run_at',
  'last_successful_run_at',
  'timezone'
]);

/**
 * Replace run-context variables (`{{run_time}}`) in the instructions. Any
 * other `{{…}}` is left for the app's own prompt variables.
 *
 * @param {string} text
 * @param {Object<string, string>} values
 * @returns {string}
 */
export function resolveRunContext(text, values) {
  if (typeof text !== 'string') return '';
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, name) =>
    RUN_CONTEXT_VARIABLES.includes(name) && Object.hasOwn(values, name)
      ? values[name] || (name.startsWith('last_') ? 'never' : '')
      : match
  );
}

/**
 * Whether an ISO timestamp is older than `days` days.
 *
 * @param {string|null} iso
 * @param {number} days
 * @param {number} now
 * @returns {boolean}
 */
export function isOlderThanDays(iso, days, now) {
  if (!days || days <= 0) return false;
  const at = parseInstant(iso);
  return !!at && now - at.getTime() > days * 86_400_000;
}
