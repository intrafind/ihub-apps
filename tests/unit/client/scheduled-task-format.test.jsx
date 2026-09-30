import {
  errorCode,
  fieldErrors,
  formToSchedule,
  reasonText,
  runChatLink,
  scheduleToForm,
  toLocalInput
} from '../../../client/src/features/tasks/utils/taskFormat';

/**
 * The task form edits a schedule the server owns: what it loads must come back
 * unchanged when nothing was touched, local times must stay in the task's time
 * zone, and the reasons the server gives must reach the viewer in their
 * language where the code allows it.
 */

// A `t` that answers from a small table, as i18next would with plurals.
function makeT(table) {
  return (key, options = {}) => {
    const plural =
      options.count === undefined ? key : `${key}_${options.count === 1 ? 'one' : 'other'}`;
    const text = table[plural] ?? table[key];
    if (text === undefined) return options.defaultValue;
    return text.replace('{{count}}', String(options.count));
  };
}

describe('scheduleToForm / formToSchedule', () => {
  it('round-trips a monthly schedule with the last-day fallback', () => {
    const schedule = {
      type: 'monthly',
      timezone: 'Europe/Berlin',
      time: '09:00',
      daysOfMonth: [15, 'last']
    };
    expect(formToSchedule(scheduleToForm(schedule))).toEqual(schedule);
  });

  it('keeps an interval anchor so an edit does not shift the slots', () => {
    const schedule = {
      type: 'interval',
      timezone: 'UTC',
      every: 2,
      unit: 'hours',
      anchorAt: '2026-01-01T00:00:00.000Z',
      maxRuns: 5
    };
    expect(formToSchedule(scheduleToForm(schedule))).toEqual(schedule);
  });

  it('shows a one-time instant in the task time zone, not the browser one', () => {
    const form = scheduleToForm({
      type: 'once',
      timezone: 'America/New_York',
      at: '2026-07-01T12:30:00.000Z'
    });
    expect(form.at).toBe('2026-07-01T08:30');
    expect(formToSchedule(form)).toEqual({
      type: 'once',
      timezone: 'America/New_York',
      at: '2026-07-01T08:30'
    });
  });

  it('sends nothing but the type for a manual task', () => {
    expect(formToSchedule({ type: 'manual', timezone: 'UTC', maxRuns: 3 })).toEqual({
      type: 'manual'
    });
  });

  it('ignores an unparsable instant', () => {
    expect(toLocalInput('not a date', 'UTC')).toBe('');
  });
});

describe('reasonText', () => {
  const t = makeT({
    'scheduledTasks.reasons.ONCE': 'Der einmalige Lauf hat stattgefunden',
    'scheduledTasks.reasons.MISSED': 'Der letzte geplante Lauf wurde verpasst',
    'scheduledTasks.reasons.MISSED_one': 'Ein Lauf wurde verpasst',
    'scheduledTasks.reasons.MISSED_other': '{{count}} Läufe wurden verpasst'
  });

  it('translates a reason the server always words the same way', () => {
    expect(reasonText(t, { code: 'ONCE', message: 'The one-time run has happened' })).toBe(
      'Der einmalige Lauf hat stattgefunden'
    );
  });

  it('counts missed slots, and tells a completed task from a skipped run', () => {
    expect(reasonText(t, { code: 'MISSED', message: 'x', missedSlots: 3 })).toBe(
      '3 Läufe wurden verpasst'
    );
    expect(reasonText(t, { code: 'MISSED', message: 'x' })).toBe(
      'Der letzte geplante Lauf wurde verpasst'
    );
  });

  it("shows an error's own message and an admin's note as they came", () => {
    expect(reasonText(t, { code: 'ERROR', message: 'Upstream 502' })).toBe('Upstream 502');
    expect(reasonText(t, { code: 'PAUSED_BY_ADMIN', message: 'Too costly' })).toBe('Too costly');
  });

  it('falls back to the server text when a translation is missing', () => {
    expect(reasonText(t, { code: 'INTERRUPTED', message: 'The server stopped' })).toBe(
      'The server stopped'
    );
    expect(reasonText(t, null)).toBe('');
  });
});

describe('API error helpers', () => {
  // `handleApiResponse` keeps the server body under `originalError.response`.
  const error = {
    originalError: {
      response: {
        data: {
          code: 'INVALID_TASK',
          details: [
            { field: 'name', message: 'A name is required' },
            { field: 'name', message: 'second message is ignored' },
            { field: 'schedule.every', message: 'Runs must be at least 15 minutes apart' }
          ]
        }
      }
    }
  };

  it('reads the code and the first message per field', () => {
    expect(errorCode(error)).toBe('INVALID_TASK');
    expect(fieldErrors(error)).toEqual({
      name: 'A name is required',
      'schedule.every': 'Runs must be at least 15 minutes apart'
    });
  });

  it('links a run to its chat only when both ids are known', () => {
    expect(runChatLink('chat', 'abc')).toBe('/apps/chat/c/abc');
    expect(runChatLink('chat', null)).toBeNull();
  });
});
