// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Cursor paging for lists that are read whole and sliced (docs/api-guidelines.md#4-lists).
 *
 * A client passes `limit` and `cursor` and gets `{ items, nextCursor }`. The cursor is opaque:
 * here it carries the position of the next item, so the same URL keeps paging the same list
 * for as long as the list does not change underneath it.
 */
import { ServiceError } from './ServiceError.js';

/** The opaque cursor for "start at item `offset`". */
export function offsetCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

/**
 * The position a cursor stands for; 0 without one.
 * @throws {ServiceError} INVALID_CURSOR for a cursor this server did not hand out
 */
export function offsetFromCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  try {
    const { o } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (Number.isSafeInteger(o) && o >= 0) return o;
  } catch {
    // falls through to the refusal
  }
  throw new ServiceError('INVALID_CURSOR', 'The cursor is not valid');
}

/** `limit` as a whole number from 1 to `max`; a larger value is capped, none gives `fallback`. */
export function limitFrom(value, { fallback, max }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** The cursor of the page after `[offset, offset + limit)` of `total` items; null at the end. */
export function nextOffsetCursor({ offset, limit, total }) {
  return offset + limit < total ? offsetCursor(offset + limit) : null;
}

/**
 * One page of an in-memory list.
 * @returns {{ items: Array, nextCursor: string|null }}
 */
export function pageOfList(list, { limit, cursor }) {
  const offset = offsetFromCursor(cursor);
  return {
    items: list.slice(offset, offset + limit),
    nextCursor: nextOffsetCursor({ offset, limit, total: list.length })
  };
}
