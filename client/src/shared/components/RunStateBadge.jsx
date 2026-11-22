// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Badge from './Badge';
import Icon from './Icon';

/**
 * The states a run is shown in, everywhere a run has a state: a chat answer, a
 * scheduled run, a sub-agent, a row of the activity list. Fixed: a new state
 * needs a new entry here, its icon, tone and two strings, never a raw value on
 * screen.
 *
 * `paused` is a run an admin held (Runs page), not a run that waits for the
 * person: that one is `waiting`. The text of `waiting` names no one ("Waiting
 * for an answer"): the badge is also shown to someone who is not the person
 * waited for (an admin, the group that answers a run of no person). "Needs you"
 * belongs to the viewer's own list of what waits for them.
 */
export const RUN_STATES = Object.freeze([
  'queued',
  'running',
  'waiting',
  'scheduled',
  'done',
  'no_change',
  'blocked',
  'needs_attention',
  'failed',
  'stopped',
  'interrupted',
  'stalled',
  'paused',
  'skipped'
]);

/**
 * The badge state of each status the server sends today, per source. The
 * statuses are the server's own words, so the same word can mean different
 * things: a run's `paused` waits for the person's answer (`waiting`), while the
 * badge state `paused` is a run an admin held.
 *
 * - `run`: the status of a run, `RUN_STATUSES` in shared/runEvents.js
 *   (`run/ended.status`, the run log). A run that used up its limit has stopped.
 * - `scheduledRun`: the status of a run of a scheduled task, `RUN_STATUSES` in
 *   server/services/scheduler/tasks/taskModel.js.
 */
export const RUN_STATE_BY_STATUS = Object.freeze({
  run: Object.freeze({
    running: 'running',
    completed: 'done',
    paused: 'waiting',
    aborted: 'stopped',
    error: 'failed',
    budget_exhausted: 'stopped'
  }),
  scheduledRun: Object.freeze({
    queued: 'queued',
    running: 'running',
    awaiting_approval: 'waiting',
    succeeded: 'done',
    failed: 'failed',
    skipped: 'skipped',
    cancelled: 'stopped'
  })
});

/**
 * The badge state of a status the server sent, or the status itself when it is
 * not listed (the badge then shows it as it is).
 *
 * @param {'run'|'scheduledRun'} source - Where the status comes from.
 * @param {string} status
 * @returns {string}
 */
export function runStateFromStatus(source, status) {
  const table = Object.hasOwn(RUN_STATE_BY_STATUS, source) ? RUN_STATE_BY_STATUS[source] : {};
  return Object.hasOwn(table, status) ? table[status] : status;
}

/** What a value outside {@link RUN_STATES} is shown as. */
export const UNKNOWN_STATE = 'unknown';

/** Tone, variant and icon per state. The icon is decoration: the text says it. */
const LOOK = {
  queued: { tone: 'neutral', icon: 'clock' },
  running: { tone: 'info', icon: 'spinner' },
  waiting: { tone: 'warning', icon: 'user' },
  scheduled: { tone: 'accent', icon: 'calendar' },
  done: { tone: 'success', icon: 'check-circle' },
  no_change: { tone: 'neutral', variant: 'outline', icon: 'minus-circle' },
  blocked: { tone: 'warning', icon: 'lock-closed' },
  needs_attention: { tone: 'warning', icon: 'exclamation-triangle' },
  failed: { tone: 'danger', icon: 'x-circle' },
  stopped: { tone: 'neutral', icon: 'stop-circle' },
  interrupted: { tone: 'warning', variant: 'outline', icon: 'arrow-path' },
  stalled: { tone: 'warning', variant: 'outline', icon: 'clock' },
  paused: { tone: 'neutral', variant: 'outline', icon: 'pause' },
  skipped: { tone: 'neutral', variant: 'outline', icon: 'arrow-right' },
  [UNKNOWN_STATE]: { tone: 'neutral', icon: 'question-mark-circle' }
};

/**
 * The text of a state. One static `t()` call per state, so the check of the
 * translation keys sees every key (it does not follow built keys).
 *
 * @param {Function} t
 * @param {string} state
 * @param {{since?: string}} [options]
 * @returns {string|null} null for a state outside {@link RUN_STATES}
 */
export function runStateLabel(t, state, { since } = {}) {
  switch (state) {
    case 'queued':
      return t('runState.queued', 'Queued');
    case 'running':
      return t('runState.running', 'Running');
    case 'waiting':
      return t('runState.waiting', 'Waiting for an answer');
    case 'scheduled':
      return t('runState.scheduled', 'Scheduled');
    case 'done':
      return t('runState.done', 'Done');
    case 'no_change':
      return t('runState.noChange', 'No change');
    case 'blocked':
      return t('runState.blocked', 'Blocked');
    case 'needs_attention':
      return t('runState.needsAttention', 'Needs attention');
    case 'failed':
      return t('runState.failed', 'Failed');
    case 'stopped':
      return t('runState.stopped', 'Stopped');
    case 'interrupted':
      return t('runState.interrupted', 'Interrupted');
    case 'stalled':
      return since
        ? t('runState.stalledSince', 'No progress since {{time}}', { time: since })
        : t('runState.stalled', 'No progress');
    case 'paused':
      return t('runState.paused', 'Paused');
    case 'skipped':
      return t('runState.skipped', 'Skipped');
    default:
      return null;
  }
}

/**
 * The icon of a state; `running` spins, and shows a still clock under
 * `prefers-reduced-motion`.
 *
 * @param {{name: string}} props
 * @returns {JSX.Element}
 */
function StateIcon({ name }) {
  if (name !== 'spinner') return <Icon name={name} size="xs" />;
  return (
    <>
      <Icon name="spinner" size="xs" className="animate-spin motion-reduce:hidden" />
      <Icon name="clock" size="xs" className="hidden motion-reduce:inline-block" />
    </>
  );
}

/**
 * RunStateBadge — the state of a run as icon plus text, on the shared `Badge`.
 *
 * The state comes from the server: one of {@link RUN_STATES}, or a server
 * status translated with {@link runStateFromStatus}; the badge never works it
 * out from anything else. A value it does not know is shown as it is, in
 * neutral, with `data-state="unknown"`, so a new server state is visible
 * rather than hidden.
 *
 * @param {Object} props
 * @param {string} props.state - One of {@link RUN_STATES}.
 * @param {string} [props.since] - For `stalled`: the time of the last progress, formatted.
 * @param {'sm'|'md'} [props.size='sm']
 * @param {boolean} [props.showIcon=true]
 * @param {string} [props.className]
 * @returns {JSX.Element}
 */
function RunStateBadge({ state, since, size = 'sm', showIcon = true, className = '' }) {
  const { t } = useTranslation();
  const known = RUN_STATES.includes(state);
  const shown = known ? state : UNKNOWN_STATE;
  const look = LOOK[shown];
  const label = known ? runStateLabel(t, state, { since }) : String(state ?? '');
  return (
    <Badge
      tone={look.tone}
      variant={look.variant || 'soft'}
      size={size}
      icon={showIcon ? <StateIcon name={look.icon} /> : null}
      className={className}
      data-state={shown}
      data-testid="run-state-badge"
    >
      {label}
    </Badge>
  );
}

export default RunStateBadge;
