/**
 * Schedules — parsing, validation and next-run arithmetic for every preset,
 * in the schedule's own timezone (DST included), with the window
 * (`startAt`, `endAt`, `maxRuns`) and the platform minimum interval.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeSchedule,
  formatZonedIso,
  nextSlot,
  nextSlots,
  normalizeSchedule,
  parseInstant,
  previewSchedule,
  slotsBetween,
  staggerOffsetMs,
  validateSchedule
} from '../services/scheduler/schedule.js';

const NOW = Date.parse('2026-10-23T10:00:00Z'); // a Friday
const iso = dates => dates.map(d => d.toISOString());

function schedule(input, options = {}) {
  const normalized = normalizeSchedule(input, { now: NOW, ...options });
  const errors = validateSchedule(normalized, { now: NOW, ...options });
  assert.deepEqual(errors, [], JSON.stringify(errors));
  return normalized;
}

describe('presets', () => {
  it('manual never runs on its own', () => {
    const s = schedule({ type: 'manual' });
    assert.equal(nextSlot(s, { after: NOW }), null);
  });

  it('once runs at its time, read in the schedule timezone', () => {
    const s = schedule({ type: 'once', at: '2026-10-24T09:00', timezone: 'America/New_York' });
    assert.equal(s.at, '2026-10-24T13:00:00.000Z');
    assert.deepEqual(iso(nextSlots(s, { after: NOW })), ['2026-10-24T13:00:00.000Z']);
    assert.equal(nextSlot(s, { after: Date.parse(s.at) }), null);
  });

  it('once in the past is refused', () => {
    const s = normalizeSchedule({ type: 'once', at: '2026-01-01T09:00', timezone: 'UTC' });
    assert.equal(validateSchedule(s, { now: NOW })[0].code, 'IN_PAST');
  });

  it('weekdays skip the weekend', () => {
    const s = schedule({ type: 'weekdays', time: '08:00', timezone: 'Europe/Berlin' });
    assert.deepEqual(iso(nextSlots(s, { after: NOW, count: 3 })), [
      '2026-10-26T07:00:00.000Z',
      '2026-10-27T07:00:00.000Z',
      '2026-10-28T07:00:00.000Z'
    ]);
  });

  it('weekly accepts day names and runs on the chosen days', () => {
    const s = schedule({ type: 'weekly', time: '14:00', days: ['mon', 'thu'], timezone: 'UTC' });
    assert.deepEqual(s.days, [1, 4]);
    assert.deepEqual(iso(nextSlots(s, { after: NOW, count: 3 })), [
      '2026-10-26T14:00:00.000Z',
      '2026-10-29T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z'
    ]);
  });

  it('monthly on the 31st falls back to the last day of shorter months', () => {
    const s = schedule({ type: 'monthly', time: '09:00', dayOfMonth: 31, timezone: 'UTC' });
    assert.deepEqual(iso(nextSlots(s, { after: NOW, count: 5 })), [
      '2026-10-31T09:00:00.000Z',
      '2026-11-30T09:00:00.000Z',
      '2026-12-31T09:00:00.000Z',
      '2027-01-31T09:00:00.000Z',
      '2027-02-28T09:00:00.000Z'
    ]);
  });

  it('monthly on the last day and the 15th', () => {
    const s = schedule({
      type: 'monthly',
      time: '09:00',
      daysOfMonth: ['15', 'last'],
      timezone: 'UTC'
    });
    assert.deepEqual(s.daysOfMonth, [15, 'last']);
    assert.deepEqual(iso(nextSlots(s, { after: NOW, count: 3 })), [
      '2026-10-31T09:00:00.000Z',
      '2026-11-15T09:00:00.000Z',
      '2026-11-30T09:00:00.000Z'
    ]);
  });

  it('an interval counts from its anchor and does not run at creation', () => {
    const s = schedule({ type: 'interval', every: 30, unit: 'min', timezone: 'UTC' });
    assert.equal(s.unit, 'minutes');
    assert.equal(s.anchorAt, new Date(NOW).toISOString());
    assert.deepEqual(iso(nextSlots(s, { after: NOW, count: 2 })), [
      '2026-10-23T10:30:00.000Z',
      '2026-10-23T11:00:00.000Z'
    ]);
  });

  it('an unchanged interval keeps its anchor on edit', () => {
    const first = schedule({ type: 'interval', every: 2, unit: 'hours', timezone: 'UTC' });
    const later = normalizeSchedule(
      { type: 'interval', every: 2, unit: 'hours', timezone: 'UTC' },
      { now: NOW + 3_600_000, previous: first }
    );
    assert.equal(later.anchorAt, first.anchorAt);
    const changed = normalizeSchedule(
      { type: 'interval', every: 3, unit: 'hours', timezone: 'UTC' },
      { now: NOW + 3_600_000, previous: first }
    );
    assert.notEqual(changed.anchorAt, first.anchorAt);
  });

  it('a day interval keeps its wall-clock time across a DST change', () => {
    const s = schedule({
      type: 'interval',
      every: 14,
      unit: 'days',
      startAt: '2026-10-20T15:00',
      timezone: 'Europe/Berlin'
    });
    // 20 Oct is CEST (UTC+2), 3 Nov is CET (UTC+1): 15:00 local both times.
    assert.deepEqual(iso(nextSlots(s, { after: Date.parse('2026-10-19T00:00:00Z'), count: 2 })), [
      '2026-10-20T13:00:00.000Z',
      '2026-11-03T14:00:00.000Z'
    ]);
  });

  it('cron uses croner syntax in the schedule timezone', () => {
    const s = schedule({ type: 'cron', cron: '0 8 * * 1-5', timezone: 'Europe/Berlin' });
    assert.equal(nextSlot(s, { after: NOW }).toISOString(), '2026-10-26T07:00:00.000Z');
  });

  it('an invalid cron expression is refused', () => {
    const s = normalizeSchedule({ type: 'cron', cron: 'not a cron', timezone: 'UTC' });
    assert.equal(validateSchedule(s, { now: NOW })[0].code, 'INVALID_CRON');
  });
});

describe('daylight saving time', () => {
  it('daily at 08:00 stays at 08:00 local across the autumn change', () => {
    const s = schedule({ type: 'daily', time: '08:00', timezone: 'Europe/Berlin' });
    assert.deepEqual(iso(nextSlots(s, { after: Date.parse('2026-10-24T00:00:00Z'), count: 2 })), [
      '2026-10-24T06:00:00.000Z',
      '2026-10-25T07:00:00.000Z'
    ]);
  });

  it('a time skipped by the spring change runs once, after the gap', () => {
    const s = schedule({ type: 'daily', time: '02:30', timezone: 'Europe/Berlin' });
    const slots = nextSlots(s, { after: Date.parse('2026-03-28T12:00:00Z'), count: 2 });
    assert.equal(slots.length, 2);
    // 29 March has no 02:30 in Berlin; the run happens that day, once.
    assert.equal(slots[0].toISOString().slice(0, 10), '2026-03-29');
    assert.equal(slots[1].toISOString(), '2026-03-30T00:30:00.000Z');
  });

  it('a time that happens twice in the autumn change runs once, the first time', () => {
    const s = schedule({ type: 'daily', time: '02:30', timezone: 'Europe/Berlin' });
    const slots = nextSlots(s, { after: Date.parse('2026-10-24T12:00:00Z'), count: 2 });
    // 25 October has 02:30 CEST (00:30Z) and 02:30 CET (01:30Z); only the first runs.
    assert.deepEqual(iso(slots), ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
  });
});

describe('window', () => {
  it('startAt delays the first run', () => {
    const s = schedule({
      type: 'daily',
      time: '09:00',
      timezone: 'UTC',
      startAt: '2026-11-01T00:00'
    });
    assert.equal(nextSlot(s, { after: NOW }).toISOString(), '2026-11-01T09:00:00.000Z');
  });

  it('endAt stops the schedule', () => {
    const s = schedule({
      type: 'daily',
      time: '09:00',
      timezone: 'UTC',
      endAt: '2026-10-24T12:00'
    });
    assert.deepEqual(iso(nextSlots(s, { after: NOW, count: 5 })), ['2026-10-24T09:00:00.000Z']);
  });

  it('maxRuns counts the runs already made', () => {
    const s = schedule({ type: 'daily', time: '09:00', timezone: 'UTC', maxRuns: 3 });
    assert.equal(nextSlots(s, { after: NOW, count: 5 }).length, 3);
    assert.equal(nextSlots(s, { after: NOW, count: 5, runCount: 2 }).length, 1);
    assert.equal(nextSlot(s, { after: NOW, runCount: 3 }), null);
  });

  it('end before start is refused', () => {
    const s = normalizeSchedule({
      type: 'daily',
      time: '09:00',
      timezone: 'UTC',
      startAt: '2026-12-01T00:00',
      endAt: '2026-11-01T00:00'
    });
    assert.ok(validateSchedule(s, { now: NOW }).some(e => e.code === 'END_BEFORE_START'));
  });
});

describe('minimum interval', () => {
  it('refuses an interval below the minimum', () => {
    const s = normalizeSchedule({ type: 'interval', every: 5, unit: 'minutes', timezone: 'UTC' });
    assert.equal(
      validateSchedule(s, { now: NOW, minIntervalMinutes: 15 })[0].code,
      'BELOW_MIN_INTERVAL'
    );
  });

  it('refuses a cron that fires more often than the minimum', () => {
    const s = normalizeSchedule({ type: 'cron', cron: '*/5 * * * *', timezone: 'UTC' });
    assert.equal(
      validateSchedule(s, { now: NOW, minIntervalMinutes: 15 })[0].code,
      'BELOW_MIN_INTERVAL'
    );
  });

  it('accepts a cron exactly at the minimum', () => {
    const s = normalizeSchedule({ type: 'cron', cron: '*/15 * * * *', timezone: 'UTC' });
    assert.deepEqual(validateSchedule(s, { now: NOW, minIntervalMinutes: 15 }), []);
  });
});

describe('missed slots', () => {
  it('lists the slots between two instants', () => {
    const s = schedule({ type: 'daily', time: '09:00', timezone: 'UTC' });
    const { slots } = slotsBetween(s, { from: Date.parse('2026-10-20T00:00:00Z'), to: NOW });
    assert.deepEqual(iso(slots), [
      '2026-10-20T09:00:00.000Z',
      '2026-10-21T09:00:00.000Z',
      '2026-10-22T09:00:00.000Z',
      '2026-10-23T09:00:00.000Z'
    ]);
  });
});

describe('describing and previewing', () => {
  it('describes a schedule in English and German', () => {
    const s = schedule({ type: 'weekly', time: '14:00', days: [1, 4], timezone: 'Europe/Berlin' });
    assert.equal(
      describeSchedule(s, 'en'),
      'Every Monday and Thursday at 14:00, time zone Europe/Berlin'
    );
    assert.equal(
      describeSchedule(s, 'de'),
      'Jeden Montag und Donnerstag um 14:00, Zeitzone Europe/Berlin'
    );
  });

  it('previews with the next runs, and reports errors instead of runs', () => {
    const ok = previewSchedule(
      { type: 'daily', time: '09:00' },
      { timezone: 'UTC', now: NOW, count: 2 }
    );
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.nextRuns, ['2026-10-24T09:00:00.000Z', '2026-10-25T09:00:00.000Z']);
    const bad = previewSchedule({ type: 'daily', time: '25:00' }, { timezone: 'UTC', now: NOW });
    assert.equal(bad.valid, false);
    assert.deepEqual(bad.nextRuns, []);
    assert.equal(bad.errors[0].field, 'schedule.time');
  });

  it('refuses an unknown timezone', () => {
    const s = normalizeSchedule({ type: 'daily', time: '09:00', timezone: 'Mars/Olympus' });
    assert.equal(validateSchedule(s, { now: NOW })[0].code, 'INVALID_TIMEZONE');
  });

  it('formats an instant with the zone offset', () => {
    assert.equal(
      formatZonedIso('2026-10-01T07:00:00Z', 'Europe/Berlin'),
      '2026-10-01T09:00:00+02:00'
    );
    assert.equal(
      formatZonedIso('2026-12-01T07:00:00Z', 'Europe/Berlin'),
      '2026-12-01T08:00:00+01:00'
    );
  });

  it('parses bare local times in the given zone and offsets as written', () => {
    assert.equal(
      parseInstant('2026-10-01T09:00', 'Europe/Berlin').toISOString(),
      '2026-10-01T07:00:00.000Z'
    );
    assert.equal(
      parseInstant('2026-10-01T09:00Z', 'Europe/Berlin').toISOString(),
      '2026-10-01T09:00:00.000Z'
    );
  });
});

describe('stagger', () => {
  it('is deterministic, inside its window, and off at zero', () => {
    const a = staggerOffsetMs('st-a', 5);
    assert.equal(a, staggerOffsetMs('st-a', 5));
    assert.ok(a >= 0 && a < 5 * 60_000);
    assert.equal(staggerOffsetMs('st-a', 0), 0);
  });
});
