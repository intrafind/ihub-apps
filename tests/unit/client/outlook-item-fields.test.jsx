/**
 * Unit tests for client/src/features/office/utilities/outlookItemFields.js
 *
 * The header readers must cope with every Office.js flavour — plain values in
 * read mode, `getAsync` accessors in compose mode, missing or throwing
 * properties on old hosts — and never fail the whole snapshot over one field.
 */

import '@testing-library/jest-dom';

const {
  readMessageHeaders,
  readMailboxUserProfile,
  normalizeRecipient,
  toIso
} = require('../../../client/src/features/office/utilities/outlookItemFields');

const SUCCEEDED = 'succeeded';
const FAILED = 'failed';

beforeEach(() => {
  global.Office = {
    AsyncResultStatus: { Succeeded: SUCCEEDED, Failed: FAILED },
    context: {
      mailbox: {
        item: null,
        userProfile: { displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' }
      }
    }
  };
});

afterEach(() => {
  delete global.Office;
});

describe('readMessageHeaders', () => {
  test('reads plain read-mode values', async () => {
    const headers = await readMessageHeaders({
      from: { displayName: 'Grace Hopper', emailAddress: 'grace@example.com' },
      to: [{ displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' }],
      cc: [],
      dateTimeCreated: new Date('2026-09-15T15:02:00Z')
    });

    expect(headers).toEqual({
      from: { name: 'Grace Hopper', email: 'grace@example.com' },
      to: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
      cc: [],
      dateTimeCreated: '2026-09-15T15:02:00.000Z'
    });
  });

  test('resolves compose-mode getAsync accessors and tolerates a failing one', async () => {
    const headers = await readMessageHeaders({
      from: {
        getAsync: cb =>
          cb({
            status: SUCCEEDED,
            value: { displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' }
          })
      },
      to: {
        getAsync: cb =>
          cb({
            status: SUCCEEDED,
            value: [{ displayName: 'Grace Hopper', emailAddress: 'grace@example.com' }]
          })
      },
      cc: { getAsync: cb => cb({ status: FAILED, error: { message: 'nope' } }) },
      dateTimeCreated: undefined
    });

    expect(headers).toEqual({
      from: { name: 'Ada Lovelace', email: 'ada@example.com' },
      to: [{ name: 'Grace Hopper', email: 'grace@example.com' }],
      cc: [],
      dateTimeCreated: null
    });
  });

  test('falls back to sender when from is missing', async () => {
    const headers = await readMessageHeaders({
      sender: { displayName: 'Delegate', emailAddress: 'delegate@example.com' }
    });

    expect(headers.from).toEqual({ name: 'Delegate', email: 'delegate@example.com' });
  });

  test('never throws on a broken or missing item', async () => {
    const broken = {
      get from() {
        throw new Error('boom');
      },
      get to() {
        throw new Error('boom');
      }
    };

    await expect(readMessageHeaders(broken)).resolves.toEqual({
      from: null,
      to: [],
      cc: [],
      dateTimeCreated: null
    });
    await expect(readMessageHeaders(null)).resolves.toEqual({
      from: null,
      to: [],
      cc: [],
      dateTimeCreated: null
    });
  });
});

describe('readMailboxUserProfile', () => {
  test('returns the signed-in user as { name, email }', () => {
    expect(readMailboxUserProfile()).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
  });

  test('returns null without a profile or outside Office', () => {
    global.Office.context.mailbox.userProfile = undefined;
    expect(readMailboxUserProfile()).toBeNull();
    delete global.Office;
    expect(readMailboxUserProfile()).toBeNull();
  });
});

describe('normalizeRecipient / toIso', () => {
  test('uses the email as the name when the display name is missing', () => {
    expect(normalizeRecipient({ emailAddress: 'x@example.com' })).toEqual({
      name: 'x@example.com',
      email: 'x@example.com'
    });
    expect(normalizeRecipient({})).toBeNull();
    expect(normalizeRecipient(null)).toBeNull();
  });

  test('normalizes dates, strings and numbers to ISO and rejects garbage', () => {
    expect(toIso(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toIso('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(toIso(0)).toBeNull();
    expect(toIso('not a date')).toBeNull();
    expect(toIso(null)).toBeNull();
  });
});
