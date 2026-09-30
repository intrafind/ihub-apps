import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { previewSchedule } from '../../../api';
import {
  SCHEDULE_TYPES,
  WEEKDAYS_MONDAY_FIRST,
  formToSchedule,
  formatDateTime,
  timezoneOptions,
  errorMessage
} from '../utils/taskFormat';

const input =
  'block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-indigo-500 focus:ring-indigo-500';
const label = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

/**
 * Schedule presets, the advanced cron field, timezone and window, and a live
 * preview from the server: the schedule in words and the next runs. The
 * server is the only judge of whether a schedule is valid — the preview shows
 * its answer before anything is saved.
 *
 * @param {Object} props
 * @param {Object} props.form - {@link scheduleToForm} state.
 * @param {(form: Object) => void} props.onChange
 * @param {number} [props.staggerMinutes=0]
 * @param {(preview: Object|null) => void} [props.onPreview]
 */
export default function ScheduleBuilder({ form, onChange, staggerMinutes = 0, onPreview }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [loading, setLoading] = useState(false);
  const zones = useMemo(() => timezoneOptions(), []);
  const requestRef = useRef(0);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  const set = patch => onChange({ ...form, ...patch });
  const schedule = useMemo(() => formToSchedule(form), [form]);
  const scheduleKey = JSON.stringify(schedule);

  useEffect(() => {
    const id = ++requestRef.current;
    const request = JSON.parse(scheduleKey);
    const timer = setTimeout(() => {
      setLoading(true);
      previewSchedule(request, { count: 5 })
        .then(result => {
          if (id !== requestRef.current) return;
          setPreview(result);
          setPreviewError(null);
          onPreviewRef.current?.(result);
        })
        .catch(error => {
          if (id !== requestRef.current) return;
          setPreview(null);
          setPreviewError(errorMessage(error));
          onPreviewRef.current?.(null);
        })
        .finally(() => {
          if (id === requestRef.current) setLoading(false);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [scheduleKey]);

  const typeLabels = {
    manual: t('scheduledTasks.schedule.types.manual', 'Only when I start it'),
    once: t('scheduledTasks.schedule.types.once', 'Once'),
    interval: t('scheduledTasks.schedule.types.interval', 'Every … minutes, hours or days'),
    daily: t('scheduledTasks.schedule.types.daily', 'Every day'),
    weekdays: t('scheduledTasks.schedule.types.weekdays', 'Every weekday (Mon–Fri)'),
    weekly: t('scheduledTasks.schedule.types.weekly', 'On selected weekdays'),
    monthly: t('scheduledTasks.schedule.types.monthly', 'Monthly'),
    cron: t('scheduledTasks.schedule.types.cron', 'Cron expression (advanced)')
  };
  const weekdayName = day =>
    new Intl.DateTimeFormat(language?.startsWith('de') ? 'de-DE' : 'en-GB', {
      weekday: 'short',
      timeZone: 'UTC'
    }).format(new Date(Date.UTC(2023, 0, 1 + day)));

  const toggleDay = day => {
    const days = form.days.includes(day) ? form.days.filter(d => d !== day) : [...form.days, day];
    set({ days: days.sort((a, b) => a - b) });
  };
  const toggleDayOfMonth = day => {
    const list = form.daysOfMonth.includes(day)
      ? form.daysOfMonth.filter(d => d !== day)
      : [...form.daysOfMonth, day];
    set({ daysOfMonth: list.sort((a, b) => a - b) });
  };

  const usesTime = ['daily', 'weekdays', 'weekly', 'monthly'].includes(form.type);
  const errorFor = field => preview?.errors?.find(e => e.field === `schedule.${field}`)?.message;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="schedule-type" className={label}>
            {t('scheduledTasks.schedule.repeat', 'Runs')}
          </label>
          <select
            id="schedule-type"
            className={input}
            value={form.type}
            onChange={e => set({ type: e.target.value })}
          >
            {SCHEDULE_TYPES.map(type => (
              <option key={type} value={type}>
                {typeLabels[type]}
              </option>
            ))}
          </select>
        </div>
        {form.type !== 'manual' && (
          <div>
            <label htmlFor="schedule-timezone" className={label}>
              {t('scheduledTasks.schedule.timezone', 'Time zone')}
            </label>
            <input
              id="schedule-timezone"
              className={input}
              list="schedule-timezones"
              value={form.timezone}
              onChange={e => set({ timezone: e.target.value })}
            />
            <datalist id="schedule-timezones">
              {zones.map(zone => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            {errorFor('timezone') && (
              <p className="mt-1 text-xs text-red-600">{errorFor('timezone')}</p>
            )}
          </div>
        )}
      </div>

      {form.type === 'once' && (
        <div className="sm:w-1/2">
          <label htmlFor="schedule-at" className={label}>
            {t('scheduledTasks.schedule.at', 'Date and time')}
          </label>
          <input
            id="schedule-at"
            type="datetime-local"
            className={input}
            value={form.at}
            onChange={e => set({ at: e.target.value })}
          />
          {errorFor('at') && <p className="mt-1 text-xs text-red-600">{errorFor('at')}</p>}
        </div>
      )}

      {form.type === 'interval' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="schedule-every" className={label}>
              {t('scheduledTasks.schedule.every', 'Every')}
            </label>
            <input
              id="schedule-every"
              type="number"
              min="1"
              className={input}
              value={form.every}
              onChange={e => set({ every: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="schedule-unit" className={label}>
              {t('scheduledTasks.schedule.unit', 'Unit')}
            </label>
            <select
              id="schedule-unit"
              className={input}
              value={form.unit}
              onChange={e => set({ unit: e.target.value })}
            >
              <option value="minutes">{t('scheduledTasks.schedule.minutes', 'Minutes')}</option>
              <option value="hours">{t('scheduledTasks.schedule.hours', 'Hours')}</option>
              <option value="days">{t('scheduledTasks.schedule.days', 'Days')}</option>
            </select>
          </div>
          {form.unit === 'days' && (
            <div>
              <label htmlFor="schedule-interval-time" className={label}>
                {t('scheduledTasks.schedule.atTime', 'At')}
              </label>
              <input
                id="schedule-interval-time"
                type="time"
                className={input}
                value={form.intervalTime}
                onChange={e => set({ intervalTime: e.target.value })}
              />
            </div>
          )}
          {errorFor('every') && (
            <p className="sm:col-span-3 text-xs text-red-600">{errorFor('every')}</p>
          )}
        </div>
      )}

      {usesTime && (
        <div className="sm:w-1/2">
          <label htmlFor="schedule-time" className={label}>
            {t('scheduledTasks.schedule.atTime', 'At')}
          </label>
          <input
            id="schedule-time"
            type="time"
            className={input}
            value={form.time}
            onChange={e => set({ time: e.target.value })}
          />
          {errorFor('time') && <p className="mt-1 text-xs text-red-600">{errorFor('time')}</p>}
        </div>
      )}

      {form.type === 'weekly' && (
        <fieldset>
          <legend className={label}>{t('scheduledTasks.schedule.onDays', 'On')}</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS_MONDAY_FIRST.map(day => {
              const selected = form.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleDay(day)}
                  className={`px-3 py-1.5 rounded-full text-sm border ${
                    selected
                      ? 'bg-indigo-600 border-indigo-600 text-white'
                      : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  {weekdayName(day)}
                </button>
              );
            })}
          </div>
          {errorFor('days') && <p className="mt-1 text-xs text-red-600">{errorFor('days')}</p>}
        </fieldset>
      )}

      {form.type === 'monthly' && (
        <fieldset>
          <legend className={label}>{t('scheduledTasks.schedule.onDaysOfMonth', 'On day')}</legend>
          <div className="grid grid-cols-7 gap-1 max-w-sm">
            {Array.from({ length: 31 }, (_, i) => i + 1).map(day => {
              const selected = form.daysOfMonth.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleDayOfMonth(day)}
                  className={`h-8 rounded text-xs border ${
                    selected
                      ? 'bg-indigo-600 border-indigo-600 text-white'
                      : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <label className="mt-2 inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={form.lastDay}
              onChange={e => set({ lastDay: e.target.checked })}
              className="rounded border-gray-300 text-indigo-600"
            />
            {t('scheduledTasks.schedule.lastDay', 'Last day of the month')}
          </label>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'scheduledTasks.schedule.monthEndHint',
              'The 29th to 31st fall back to the last day of shorter months.'
            )}
          </p>
          {errorFor('daysOfMonth') && (
            <p className="mt-1 text-xs text-red-600">{errorFor('daysOfMonth')}</p>
          )}
        </fieldset>
      )}

      {form.type === 'cron' && (
        <div>
          <label htmlFor="schedule-cron" className={label}>
            {t('scheduledTasks.schedule.cron', 'Cron expression')}
          </label>
          <input
            id="schedule-cron"
            className={`${input} font-mono`}
            placeholder="0 8 * * 1-5"
            value={form.cron}
            onChange={e => set({ cron: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'scheduledTasks.schedule.cronHint',
              'Minute, hour, day of month, month, weekday — e.g. "0 8 * * 1-5" is 08:00 on weekdays.'
            )}
          </p>
          {errorFor('cron') && <p className="mt-1 text-xs text-red-600">{errorFor('cron')}</p>}
        </div>
      )}

      {!['manual', 'once'].includes(form.type) && (
        <details className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('scheduledTasks.schedule.window', 'Start, end and number of runs')}
          </summary>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3">
            <div>
              <label htmlFor="schedule-start" className={label}>
                {t('scheduledTasks.schedule.startAt', 'Start')}
              </label>
              <input
                id="schedule-start"
                type="datetime-local"
                className={input}
                value={form.startAt}
                onChange={e => set({ startAt: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="schedule-end" className={label}>
                {t('scheduledTasks.schedule.endAt', 'End')}
              </label>
              <input
                id="schedule-end"
                type="datetime-local"
                className={input}
                value={form.endAt}
                onChange={e => set({ endAt: e.target.value })}
              />
              {errorFor('endAt') && (
                <p className="mt-1 text-xs text-red-600">{errorFor('endAt')}</p>
              )}
            </div>
            <div>
              <label htmlFor="schedule-max" className={label}>
                {t('scheduledTasks.schedule.maxRuns', 'Stop after … runs')}
              </label>
              <input
                id="schedule-max"
                type="number"
                min="1"
                className={input}
                value={form.maxRuns}
                onChange={e => set({ maxRuns: e.target.value })}
              />
            </div>
          </div>
        </details>
      )}

      <div
        className="rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-3 text-sm"
        aria-live="polite"
      >
        {loading && !preview && (
          <p className="text-gray-500 dark:text-gray-400">
            {t('scheduledTasks.schedule.checking', 'Checking the schedule…')}
          </p>
        )}
        {previewError && <p className="text-red-600">{previewError}</p>}
        {preview && !preview.valid && (
          <ul className="text-red-600 list-disc list-inside">
            {preview.errors.map(error => (
              <li key={`${error.field}-${error.code}`}>{error.message}</li>
            ))}
          </ul>
        )}
        {preview?.valid && (
          <>
            <p className="font-medium text-gray-900 dark:text-gray-100">{preview.description}</p>
            {preview.nextRuns.length > 0 ? (
              <>
                <p className="mt-2 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('scheduledTasks.schedule.nextRuns', 'Next runs')}
                </p>
                <ul className="mt-1 space-y-0.5 text-gray-700 dark:text-gray-300">
                  {preview.nextRuns.map(run => (
                    <li key={run}>
                      {formatDateTime(run, language, {
                        timeZone: preview.schedule.timezone,
                        weekday: true
                      })}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              form.type !== 'manual' && (
                <p className="mt-1 text-amber-700 dark:text-amber-400">
                  {t('scheduledTasks.schedule.noFutureRuns', 'This schedule has no future runs.')}
                </p>
              )
            )}
            {staggerMinutes > 0 && form.type !== 'manual' && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'scheduledTasks.schedule.staggerNote',
                  'To spread the load, a run may start up to {{minutes}} minutes late.',
                  { minutes: staggerMinutes }
                )}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
