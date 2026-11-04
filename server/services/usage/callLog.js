// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The request log: individual call records of a range, newest first, read
 * from the daily event files and filtered. Metadata only — the records hold
 * tokens, outcome and timing, never prompt or response text. Kept as long as
 * the event files (`usageTracking.eventRetentionDays`).
 *
 * Paging uses a cursor (timestamp + position in the day file), so records
 * written while an admin pages do not shift the pages.
 *
 * @module services/usage/callLog
 */
import { readDayEvents, flushQueue } from '../UsageEventLog.js';
import { resolveRange, UsageQueryError } from './usageQuery.js';
import { OUTCOMES, SURFACES } from './callRecord.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE = 200;

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(text) {
  if (!text) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'));
    if (typeof cursor?.ts === 'string' && Number.isInteger(cursor.i)) return cursor;
  } catch {
    /* fall through */
  }
  throw new UsageQueryError('Invalid cursor');
}

/** Whether (ts, i) comes after the cursor in newest-first order. */
function afterCursor(entry, cursor) {
  if (!cursor) return true;
  if (entry.ts !== cursor.ts) return entry.ts < cursor.ts;
  return entry.i < cursor.i;
}

function text(value, max = 200) {
  return typeof value === 'string' && value ? value.slice(0, max) : '';
}

/**
 * One page of call records.
 *
 * @param {Object} params - range params plus filters `user`, `app`, `model`,
 *   `surface`, `outcome`, and `limit`, `cursor`
 * @param {number} [now]
 * @returns {Promise<{items: Object[], nextCursor: string|null, from: string, to: string}>}
 */
export async function queryCalls(params = {}, now = Date.now()) {
  const resolved = resolveRange(params, now);
  const filters = {
    uid: text(params.user),
    app: text(params.app),
    model: text(params.model),
    surf: text(params.surface),
    st: text(params.outcome)
  };
  if (filters.surf && !SURFACES.includes(filters.surf)) {
    throw new UsageQueryError(`Unknown surface: ${filters.surf}`);
  }
  if (filters.st && !OUTCOMES.includes(filters.st)) {
    throw new UsageQueryError(`Unknown outcome: ${filters.st}`);
  }
  const limit = Math.min(Math.max(Number.parseInt(params.limit, 10) || 50, 1), MAX_PAGE);
  const cursor = decodeCursor(params.cursor);
  if (resolved.to >= now - DAY_MS) await flushQueue().catch(() => {});

  const fromIso = new Date(resolved.from).toISOString();
  const toIso = new Date(resolved.to).toISOString();
  const lastDay = cursor ? cursor.ts.slice(0, 10) : toIso.slice(0, 10);
  const firstDay = fromIso.slice(0, 10);

  const items = [];
  let more = false;
  for (
    let t = Date.parse(`${lastDay}T00:00:00Z`);
    t >= Date.parse(`${firstDay}T00:00:00Z`);
    t -= DAY_MS
  ) {
    const day = new Date(t).toISOString().slice(0, 10);
    const entries = (await readDayEvents(day))
      .map((record, i) => ({ record, ts: record.ts, i }))
      .filter(
        ({ record }) =>
          record.type === 'llm_call' &&
          record.ts >= fromIso &&
          record.ts <= toIso &&
          Object.entries(filters).every(([key, value]) => !value || record[key] === value)
      )
      .sort((a, b) => (a.ts === b.ts ? b.i - a.i : a.ts < b.ts ? 1 : -1));
    for (const entry of entries) {
      if (!afterCursor(entry, cursor)) continue;
      if (items.length === limit) {
        more = true;
        break;
      }
      items.push({
        id: `${day}:${entry.i}`,
        ...entry.record,
        _cursor: { ts: entry.ts, i: entry.i }
      });
    }
    if (more) break;
  }
  const last = items[items.length - 1];
  return {
    from: fromIso,
    to: toIso,
    items: items.map(({ _cursor, ...item }) => item),
    nextCursor: more && last ? encodeCursor(last._cursor) : null
  };
}
