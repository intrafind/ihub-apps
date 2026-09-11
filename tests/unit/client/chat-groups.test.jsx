import {
  CHAT_GROUPS,
  chatRecencyGroup,
  groupChatsByRecency
} from '../../../client/src/utils/chatGroups';

/**
 * The "Today / Yesterday / Last 7 days / Older" headings in the chat history.
 * `GET /api/chats` returns the stored document and nothing else, so the bucket
 * is derived here from `lastMessageAt` — and the reader's notion of "yesterday"
 * is a calendar day, not a rolling 24-hour window: at 00:10 a chat from 23:50
 * last night belongs under Yesterday, however few minutes ago it was.
 *
 * `now` is injected everywhere so the boundaries are assertable at all and so a
 * single list can never be rendered from two clock readings.
 */

/** Local-time instant. Local, because the buckets are local calendar days. */
const at = (year, month, day, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0, 0);

const NOW = at(2026, 3, 15, 10, 30);
const chat = (id, lastMessageAt) => ({ id, lastMessageAt });

describe('chatRecencyGroup', () => {
  test('the bucket ids are ordered newest first', () => {
    expect(CHAT_GROUPS).toEqual(['today', 'yesterday', 'last7days', 'older']);
  });

  test('anything on the current calendar day is today', () => {
    expect(chatRecencyGroup(at(2026, 3, 15, 0, 0), NOW)).toBe('today');
    expect(chatRecencyGroup(at(2026, 3, 15, 10, 29), NOW)).toBe('today');
    expect(chatRecencyGroup(at(2026, 3, 15, 23, 59), NOW)).toBe('today');
  });

  test('midnight is the boundary, not a 24-hour window', () => {
    const justAfterMidnight = at(2026, 3, 15, 0, 10);
    // Twenty minutes earlier, and already "yesterday" to a reader.
    expect(chatRecencyGroup(at(2026, 3, 14, 23, 50), justAfterMidnight)).toBe('yesterday');
    expect(chatRecencyGroup(at(2026, 3, 15, 0, 0), justAfterMidnight)).toBe('today');
  });

  test('the whole previous calendar day is yesterday', () => {
    expect(chatRecencyGroup(at(2026, 3, 14, 0, 0), NOW)).toBe('yesterday');
    expect(chatRecencyGroup(at(2026, 3, 14, 23, 59), NOW)).toBe('yesterday');
  });

  test('the seven-day edge: day six is recent, day seven is older', () => {
    expect(chatRecencyGroup(at(2026, 3, 13), NOW)).toBe('last7days');
    expect(chatRecencyGroup(at(2026, 3, 9, 0, 0), NOW)).toBe('last7days');
    expect(chatRecencyGroup(at(2026, 3, 9, 23, 59), NOW)).toBe('last7days');
    expect(chatRecencyGroup(at(2026, 3, 8, 23, 59), NOW)).toBe('older');
    expect(chatRecencyGroup(at(2025, 12, 31), NOW)).toBe('older');
  });

  test('a 23-hour day across spring forward is still one calendar day', () => {
    // Europe/Berlin springs forward on 2026-03-29, so local midnight to local
    // midnight is 23 hours. Every other instant in this file sits in a window
    // with no transition, where a day is exactly 86.4M ms and rounding cannot
    // be told from truncating — which is how `Math.floor` here would file a
    // chat from the 29th under Today on the 30th and keep the suite green.
    const morningAfter = at(2026, 3, 30, 9, 0);
    expect(chatRecencyGroup(at(2026, 3, 29, 22, 0), morningAfter)).toBe('yesterday');
    expect(chatRecencyGroup(at(2026, 3, 30, 0, 30), morningAfter)).toBe('today');
    // And the seven-day edge measured across the same transition.
    expect(chatRecencyGroup(at(2026, 3, 24, 12, 0), morningAfter)).toBe('last7days');
    expect(chatRecencyGroup(at(2026, 3, 23, 12, 0), morningAfter)).toBe('older');
  });

  test('a 25-hour day across fall back is still one calendar day', () => {
    // The other direction, on 2026-10-25: 25 hours between local midnights.
    const morningAfter = at(2026, 10, 26, 9, 0);
    expect(chatRecencyGroup(at(2026, 10, 25, 22, 0), morningAfter)).toBe('yesterday');
    expect(chatRecencyGroup(at(2026, 10, 26, 0, 30), morningAfter)).toBe('today');
    expect(chatRecencyGroup(at(2026, 10, 20, 12, 0), morningAfter)).toBe('last7days');
    expect(chatRecencyGroup(at(2026, 10, 19, 12, 0), morningAfter)).toBe('older');
  });

  test('a clock skew into the future reads as today rather than inventing a bucket', () => {
    expect(chatRecencyGroup(at(2026, 3, 15, 23, 0), NOW)).toBe('today');
    expect(chatRecencyGroup(at(2026, 3, 16, 9, 0), NOW)).toBe('today');
  });

  test('a missing or unusable timestamp sorts last instead of to the top', () => {
    expect(chatRecencyGroup(undefined, NOW)).toBe('older');
    expect(chatRecencyGroup(null, NOW)).toBe('older');
    expect(chatRecencyGroup('', NOW)).toBe('older');
    expect(chatRecencyGroup('whenever', NOW)).toBe('older');
    expect(chatRecencyGroup(new Date('nope'), NOW)).toBe('older');
  });

  test('takes the timestamp as an ISO string, epoch millis or a Date', () => {
    const yesterday = at(2026, 3, 14, 9, 0);
    expect(chatRecencyGroup(yesterday.toISOString(), NOW)).toBe('yesterday');
    expect(chatRecencyGroup(yesterday.getTime(), NOW)).toBe('yesterday');
    expect(chatRecencyGroup(yesterday, NOW)).toBe('yesterday');
  });
});

describe('groupChatsByRecency', () => {
  test('buckets the list newest bucket first and omits the empty ones', () => {
    const chats = [
      chat('now', at(2026, 3, 15, 9, 0)),
      chat('long-ago', at(2026, 1, 2)),
      chat('this-week', at(2026, 3, 11))
    ];

    expect(groupChatsByRecency(chats, NOW)).toEqual([
      { key: 'today', items: [chats[0]] },
      { key: 'last7days', items: [chats[2]] },
      { key: 'older', items: [chats[1]] }
    ]);
  });

  test('keeps the order the API returned inside a bucket', () => {
    const chats = [
      chat('a', at(2026, 3, 15, 9, 0)),
      chat('b', at(2026, 3, 15, 8, 0)),
      chat('c', at(2026, 3, 15, 10, 0))
    ];

    const [today] = groupChatsByRecency(chats, NOW);
    expect(today.items.map(item => item.id)).toEqual(['a', 'b', 'c']);
  });

  test('one clock reading covers the whole list', () => {
    // Rendered a hair before midnight: everything from that day stays "today"
    // even though evaluating each row against its own `new Date()` could roll
    // some of them over into "yesterday" mid-list.
    const almostMidnight = at(2026, 3, 15, 23, 59);
    const chats = [chat('a', at(2026, 3, 15, 23, 58)), chat('b', at(2026, 3, 15, 0, 1))];

    expect(groupChatsByRecency(chats, almostMidnight)).toEqual([{ key: 'today', items: chats }]);
  });

  test('chats with no usable timestamp end up under older', () => {
    const chats = [chat('a', at(2026, 3, 15, 9, 0)), { id: 'never-sent' }];

    expect(groupChatsByRecency(chats, NOW)).toEqual([
      { key: 'today', items: [chats[0]] },
      { key: 'older', items: [chats[1]] }
    ]);
  });

  test('an empty or unusable list renders nothing rather than empty headings', () => {
    expect(groupChatsByRecency([], NOW)).toEqual([]);
    expect(groupChatsByRecency(undefined, NOW)).toEqual([]);
    expect(groupChatsByRecency(null, NOW)).toEqual([]);
    expect(groupChatsByRecency([null, undefined], NOW)).toEqual([]);
  });
});
