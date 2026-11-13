// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { PROGRESS_RENDER_MS } from '../activityConstants.js';
import { stalledLabel } from '../activityHeadline.js';
import { elapsedAt } from '../activityTiming.js';

/**
 * Building blocks of the run activity list (`ToolActivity`): the busy icon, the
 * honest progress line ("12 KB written · 0:41"), the shared one-second clock,
 * the row chip and the stall caption. Issue #3534.
 *
 * Progress here is a count of what the model has written and a clock, never a
 * percentage and never a bar: the total is unknown, so any fraction would be
 * invented and would stall near the end, which is exactly the "is it hung?"
 * feeling this display exists to remove.
 *
 * @module features/chat/components/ActivityProgress
 */

/** Colour of an active status icon: indigo-600 on light, indigo-400 on dark (the dark pair is the one that passes contrast). */
export const ACTIVE_ICON = 'text-indigo-600 dark:text-indigo-400';

/** Separator between the parts of a progress line. */
const SEPARATOR = ' · ';

/**
 * A size for the progress line: nothing below 1 KB, whole KB up to 1 MB, from
 * there MB with one decimal, in the reader's number format (`1,4 MB` in German).
 * The unit is the same in every language.
 *
 * @param {number} argBytes - bytes of arguments written so far
 * @param {string} [language] - BCP 47 tag, e.g. `i18n.language`
 * @returns {string} e.g. `12 KB`, or '' when there is no size to show yet
 */
export function formatSize(argBytes, language) {
  const bytes = Number(argBytes);
  if (!Number.isFinite(bytes) || bytes < 1024) return '';
  const format = (value, digits) => {
    const options = { minimumFractionDigits: digits, maximumFractionDigits: digits };
    try {
      return new Intl.NumberFormat(language || undefined, options).format(value);
    } catch {
      // A language tag the runtime does not know.
      return new Intl.NumberFormat('en', options).format(value);
    }
  };
  const kilobytes = Math.round(bytes / 1024);
  if (kilobytes < 1024) return `${format(kilobytes, 0)} KB`;
  return `${format(bytes / (1024 * 1024), 1)} MB`;
}

/**
 * A stopwatch reading: `m:ss`, and `h:mm:ss` from one hour.
 *
 * @param {number} ms - milliseconds
 * @returns {string} e.g. `0:07`, `12:05`, `1:00:00`
 */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

// ── the shared clock ──────────────────────────────────────────────────────

const clockListeners = new Set();
let clockTimer = null;
let clockReading = performance.now();

function subscribeToClock(listener) {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockReading = performance.now();
    clockTimer = setInterval(() => {
      clockReading = performance.now();
      clockListeners.forEach(notify => notify());
    }, PROGRESS_RENDER_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const readClock = () => clockReading;
const subscribeToNothing = () => () => {};

/**
 * The time every ticking part of the activity list reads, from one interval
 * shared by all of them, so the headline and the row tick in step and a chat
 * with nothing in progress has no timer at all.
 *
 * @param {boolean} [active=true] - false subscribes to nothing; the value is then not meaningful
 * @returns {number} `performance.now()` as of the last tick
 */
export function useNow(active = true) {
  return useSyncExternalStore(active ? subscribeToClock : subscribeToNothing, readClock);
}

// ── parts ──────────────────────────────────────────────────────────────────

/**
 * The busy icon: a rotating spinner, and under `prefers-reduced-motion` a
 * static glyph instead (the global reduced-motion rule would only freeze the
 * spinner mid-turn, which looks hung). Both are rendered and CSS picks one, so
 * it follows a change of the OS setting without any script.
 *
 * @param {Object} props
 * @param {'xs'|'sm'|'md'|'lg'} [props.size='sm']
 * @param {'accent'|'inherit'} [props.tone='accent'] - `accent` is the indigo of an active status
 * @param {'clock'|'light-bulb'} [props.staticIcon='clock'] - the glyph under reduced motion
 * @param {string} [props.className]
 */
export function BusyIcon({ size = 'sm', tone = 'accent', staticIcon = 'clock', className = '' }) {
  const colour = tone === 'accent' ? ACTIVE_ICON : '';
  return (
    <>
      <Icon
        name="spinner"
        size={size}
        className={`shrink-0 animate-spin motion-reduce:hidden ${colour} ${className}`}
      />
      <Icon
        name={staticIcon}
        size={size}
        className={`hidden shrink-0 motion-reduce:inline-block ${colour} ${className}`}
      />
    </>
  );
}

/**
 * What the model has written so far and for how long: `12 KB written · 0:41`.
 *
 * Always `aria-hidden`: these numbers change every second, and a screen reader
 * is told about the call once by the `RunAnnouncer` instead. The clock is the
 * newest frame's reading plus the time since it arrived (see `elapsedAt`), the
 * size the newest frame's `argBytes`. Neither is part of a translated string.
 *
 * @param {Object} props
 * @param {number|null} [props.argBytes] - bytes written; no size is shown below 1 KB
 * @param {number} [props.elapsedMs] - the newest frame's stopwatch reading
 * @param {number} [props.receivedAt] - when that frame arrived (`performance.now()`)
 * @param {boolean} [props.running=true] - false freezes the clock (finished, stopped, ready)
 * @param {'readyToRun'|null} [props.suffix] - replaces the clock with "ready to run"
 * @param {boolean} [props.lead=false] - start with a separator, for a suffix after a label
 * @param {string} [props.className]
 */
export function ArgumentProgress({
  argBytes = null,
  elapsedMs = 0,
  receivedAt,
  running = true,
  suffix = null,
  lead = false,
  className = ''
}) {
  const { t, i18n } = useTranslation();
  const now = useNow(running);
  const elapsed = elapsedAt({ elapsedMs, receivedAt }, now, running);
  const parts = [];
  const size = formatSize(argBytes, i18n?.language);
  if (size) parts.push(t('toolActivity.written', '{{size}} written', { size }));
  if (suffix === 'readyToRun') parts.push(t('toolActivity.readyToRun', 'ready to run'));
  else parts.push(formatClock(elapsed));
  return (
    <span aria-hidden="true" className={`tabular-nums ${className}`}>
      <bdi>{(lead ? SEPARATOR : '') + parts.join(SEPARATOR)}</bdi>
    </span>
  );
}

/**
 * The chip of a row: the integration a call ran against, "No. 2" on a repeat.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @param {string} [props.className]
 */
export function RowChip({ children, className = '', ...rest }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}

/**
 * A calm caption under a row. Not announced by itself (the list is silent, the
 * `RunAnnouncer` speaks), no icon and no button: Stop is already on screen.
 *
 * @param {Object} props
 * @param {'stalled'|null} props.kind
 */
export function ActivityHint({ kind }) {
  const { t } = useTranslation();
  if (kind !== 'stalled') return null;
  return (
    <p className="mt-1 ms-5.5 break-words text-gray-600 dark:text-gray-400">{stalledLabel(t)}</p>
  );
}
