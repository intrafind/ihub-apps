/**
 * Unit tests for client/src/features/office/utilities/outlookMailContext.js
 *
 * Regression coverage for the stale-attachment / frozen-context bugs:
 *   - fetchCurrentMailContext must return an atomic snapshot: when the user
 *     switches emails mid-read, the fetch retries against the new item
 *     instead of returning old descriptors whose content fetches fail with
 *     "The attachment identifier does not exist".
 */
/* global Office */

import '@testing-library/jest-dom';

const {
  fetchCurrentMailContext
} = require('../../../client/src/features/office/utilities/outlookMailContext');

const SUCCEEDED = 'succeeded';
const FAILED = 'failed';

function installOfficeMock() {
  global.Office = {
    AsyncResultStatus: { Succeeded: SUCCEEDED, Failed: FAILED },
    CoercionType: { Text: 'text' },
    context: {
      mailbox: {
        item: null,
        userProfile: { displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' }
      }
    }
  };
  return global.Office;
}

/**
 * Build a fake read-mode mail item. Attachment content requests behave like
 * the Outlook host: an id is only served when it belongs to the item that is
 * CURRENTLY selected (Office.context.mailbox.item), regardless of which item
 * proxy the call went through — foreign ids fail with the canonical
 * InvalidAttachmentId message.
 */
function makeMailItem({
  itemId,
  subject,
  bodyText,
  attachments = [],
  onBodyRead,
  from,
  to,
  cc,
  dateTimeCreated
}) {
  const item = {
    itemId,
    itemType: 'message',
    subject,
    from,
    to,
    cc,
    dateTimeCreated,
    attachments: attachments.map(a => ({
      id: a.id,
      name: a.name,
      size: a.size ?? 100,
      contentType: a.contentType ?? 'application/pdf',
      attachmentType: 'file',
      isInline: !!a.isInline
    })),
    body: {
      getAsync: (_coercion, cb) => {
        setTimeout(() => {
          onBodyRead?.();
          cb({ status: SUCCEEDED, value: bodyText });
        }, 0);
      }
    },
    getAttachmentContentAsync: (id, cb) => {
      setTimeout(() => {
        const live = global.Office.context.mailbox.item;
        const servedByLiveItem = live?.attachments?.some(x => x.id === id);
        if (!servedByLiveItem) {
          cb({
            status: FAILED,
            error: { message: 'The attachment identifier does not exist.' }
          });
          return;
        }
        cb({ status: SUCCEEDED, value: { format: 'base64', content: `CONTENT(${id})` } });
      }, 0);
    }
  };
  return item;
}

beforeEach(() => {
  installOfficeMock();
});

afterEach(() => {
  delete global.Office;
});

describe('fetchCurrentMailContext', () => {
  test('re-reads the item when every attachment fetch fails with an unknown id (stale item right after ItemChanged)', async () => {
    // The host already serves email B, but Office.context.mailbox.item still
    // hands out A's cached attachment list under B's id. Without the re-read
    // the pane shows A's attachments, each marked as failed, next to B's body.
    const freshB = makeMailItem({
      itemId: 'B',
      subject: 'Mail B',
      bodyText: 'body of B',
      attachments: [{ id: 'b1', name: 'invoice.pdf' }]
    });
    const staleB = makeMailItem({
      itemId: 'B',
      subject: 'Mail A',
      bodyText: 'body of B',
      attachments: [{ id: 'a1', name: 'report.pdf' }]
    });
    staleB.getAttachmentContentAsync = (_id, cb) =>
      setTimeout(
        () =>
          cb({ status: FAILED, error: { message: 'The attachment identifier does not exist.' } }),
        0
      );
    Office.context.mailbox.item = staleB;
    // The framework refreshes its cached item a moment later.
    setTimeout(() => {
      global.Office.context.mailbox.item = freshB;
    }, 50);

    const ctx = await fetchCurrentMailContext();

    expect(ctx.available).toBe(true);
    expect(ctx.subject).toBe('Mail B');
    expect(ctx.attachments).toHaveLength(1);
    expect(ctx.attachments[0]).toMatchObject({
      id: 'b1',
      content: { format: 'base64', content: 'CONTENT(b1)' }
    });
  });

  test('a genuine per-attachment failure is reported after a single read, not retried', async () => {
    let bodyReads = 0;
    const itemA = makeMailItem({
      itemId: 'A',
      subject: 'Mail A',
      bodyText: 'body of A',
      attachments: [{ id: 'a1', name: 'note.msg' }],
      onBodyRead: () => {
        bodyReads++;
      }
    });
    itemA.getAttachmentContentAsync = (_id, cb) =>
      setTimeout(() => cb({ status: FAILED, error: { message: 'AttachmentTypeNotSupported' } }), 0);
    Office.context.mailbox.item = itemA;

    const ctx = await fetchCurrentMailContext();

    expect(ctx.attachments[0].error).toBe('AttachmentTypeNotSupported');
    expect(bodyReads).toBe(1);
  });

  test('a torn read that never settles still returns the email on the last attempt', async () => {
    const staleB = makeMailItem({
      itemId: 'B',
      subject: 'Mail B',
      bodyText: 'body of B',
      attachments: [{ id: 'a1', name: 'report.pdf' }]
    });
    staleB.getAttachmentContentAsync = (_id, cb) =>
      setTimeout(
        () =>
          cb({ status: FAILED, error: { message: 'The attachment identifier does not exist.' } }),
        0
      );
    Office.context.mailbox.item = staleB;

    const ctx = await fetchCurrentMailContext();

    expect(ctx.available).toBe(true);
    expect(ctx.bodyText).toBe('body of B');
    expect(ctx.attachments[0].error).toMatch(/does not exist/);
  });

  test('returns a full snapshot (subject, headers, body, attachment content) for a stable item', async () => {
    const itemA = makeMailItem({
      itemId: 'A',
      subject: 'Mail A',
      bodyText: 'body of A',
      from: { displayName: 'Grace Hopper', emailAddress: 'grace@example.com' },
      to: [{ displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' }],
      cc: [{ displayName: 'Linus', emailAddress: 'linus@example.com' }],
      dateTimeCreated: new Date('2026-09-15T15:02:00Z'),
      attachments: [
        { id: 'a1', name: 'report.pdf' },
        { id: 'a2', name: 'logo.png', contentType: 'image/png', isInline: true }
      ]
    });
    Office.context.mailbox.item = itemA;

    const ctx = await fetchCurrentMailContext();

    expect(ctx.available).toBe(true);
    expect(ctx.itemId).toBe('A');
    expect(ctx.subject).toBe('Mail A');
    expect(ctx.bodyText).toBe('body of A');
    expect(ctx.from).toEqual({ name: 'Grace Hopper', email: 'grace@example.com' });
    expect(ctx.to).toEqual([{ name: 'Ada Lovelace', email: 'ada@example.com' }]);
    expect(ctx.cc).toEqual([{ name: 'Linus', email: 'linus@example.com' }]);
    expect(ctx.dateTimeCreated).toBe('2026-09-15T15:02:00.000Z');
    expect(ctx.mailboxUser).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(ctx.attachments).toHaveLength(2);
    expect(ctx.attachments[0]).toMatchObject({
      id: 'a1',
      content: { format: 'base64', content: 'CONTENT(a1)' }
    });
    expect(ctx.attachments.every(a => !a.error)).toBe(true);
  });

  test('retries against the new item when the selection changes mid-read (no stale invalid attachments)', async () => {
    const itemB = makeMailItem({
      itemId: 'B',
      subject: 'Mail B',
      bodyText: 'body of B',
      attachments: [{ id: 'b1', name: 'invoice.pdf' }]
    });
    const itemA = makeMailItem({
      itemId: 'A',
      subject: 'Mail A',
      bodyText: 'body of A',
      attachments: [{ id: 'a1', name: 'report.pdf' }],
      // Simulate the user selecting email B while A's body is being read:
      // the host swaps the live item under the in-flight fetch.
      onBodyRead: () => {
        global.Office.context.mailbox.item = itemB;
      }
    });
    Office.context.mailbox.item = itemA;

    const ctx = await fetchCurrentMailContext();

    // The old behavior returned A's descriptors with per-attachment
    // "attachment identifier does not exist" errors. The fetch must instead
    // restart and deliver B's snapshot.
    expect(ctx.available).toBe(true);
    expect(ctx.itemId).toBe('B');
    expect(ctx.subject).toBe('Mail B');
    expect(ctx.attachments).toHaveLength(1);
    expect(ctx.attachments[0]).toMatchObject({
      id: 'b1',
      content: { format: 'base64', content: 'CONTENT(b1)' }
    });
    expect(ctx.attachments.every(a => !a.error)).toBe(true);
  });

  test('gives up with available:false when the item keeps changing across every attempt', async () => {
    // Chain of items where every body read swaps the selection again, so no
    // attempt ever completes on a stable item.
    const items = [];
    for (let i = 0; i < 5; i++) {
      items.push(
        makeMailItem({
          itemId: `item-${i}`,
          subject: `Mail ${i}`,
          bodyText: `body ${i}`,
          onBodyRead: () => {
            global.Office.context.mailbox.item = items[i + 1] ?? items[i];
          }
        })
      );
    }
    // Last item does not swap — but the loop should have given up by then.
    items[4] = makeMailItem({ itemId: 'item-4', subject: 'Mail 4', bodyText: 'body 4' });
    Office.context.mailbox.item = items[0];

    const ctx = await fetchCurrentMailContext();

    expect(ctx.available).toBe(false);
    expect(ctx.attachments).toEqual([]);
  });

  test('switch away and back mid-download retries instead of returning a truncated attachment list', async () => {
    const itemB = makeMailItem({ itemId: 'B', subject: 'Mail B', bodyText: 'body of B' });
    const itemA = makeMailItem({
      itemId: 'A',
      subject: 'Mail A',
      bodyText: 'body of A',
      attachments: [
        { id: 'a1', name: 'first.pdf' },
        { id: 'a2', name: 'second.pdf' }
      ]
    });
    // While a1's content arrives, the user flips to B and immediately back
    // to A. The download loop aborts during the B interval, but by the time
    // the post-read itemId check runs the live item is A again — without the
    // aborted flag, a snapshot with only a1 missing-in-silence would be
    // returned as intact.
    const originalGetContent = itemA.getAttachmentContentAsync;
    let flipped = false;
    itemA.getAttachmentContentAsync = (id, cb) => {
      if (id === 'a1' && !flipped) {
        flipped = true;
        setTimeout(() => {
          global.Office.context.mailbox.item = itemB;
          cb({ status: SUCCEEDED, value: { format: 'base64', content: 'CONTENT(a1)' } });
          queueMicrotask(() => {
            global.Office.context.mailbox.item = itemA;
          });
        }, 0);
        return;
      }
      originalGetContent(id, cb);
    };
    Office.context.mailbox.item = itemA;

    const ctx = await fetchCurrentMailContext();

    expect(ctx.available).toBe(true);
    expect(ctx.itemId).toBe('A');
    expect(ctx.attachments).toHaveLength(2);
    expect(ctx.attachments.map(a => a.id)).toEqual(['a1', 'a2']);
    expect(ctx.attachments.every(a => a.content && !a.error)).toBe(true);
  });

  test('still records per-attachment errors when the item is stable but the host rejects one id', async () => {
    const itemA = makeMailItem({
      itemId: 'A',
      subject: 'Mail A',
      bodyText: 'body of A',
      attachments: [
        { id: 'ok1', name: 'fine.pdf' },
        { id: 'bad1', name: 'contact.msg' }
      ]
    });
    // Simulate AttachmentTypeNotSupported for one attachment only.
    const originalGetContent = itemA.getAttachmentContentAsync;
    itemA.getAttachmentContentAsync = (id, cb) => {
      if (id === 'bad1') {
        setTimeout(
          () => cb({ status: FAILED, error: { message: 'AttachmentTypeNotSupported' } }),
          0
        );
        return;
      }
      originalGetContent(id, cb);
    };
    Office.context.mailbox.item = itemA;

    const ctx = await fetchCurrentMailContext();

    expect(ctx.available).toBe(true);
    expect(ctx.attachments).toHaveLength(2);
    expect(ctx.attachments[0].content).toBeDefined();
    expect(ctx.attachments[1].error).toBe('AttachmentTypeNotSupported');
  });
});
