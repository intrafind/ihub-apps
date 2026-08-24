/**
 * Unit tests for client/src/features/office/utilities/outlookMailContext.js
 *
 * Regression coverage for the stale-attachment / frozen-context bugs:
 *   - fetchCurrentMailContext must return an atomic snapshot: when the user
 *     switches emails mid-read, the fetch retries against the new item
 *     instead of returning old descriptors whose content fetches fail with
 *     "The attachment identifier does not exist".
 *   - fetchSelectedItemsContext must skip the loadItemByIdAsync/unloadAsync
 *     cycle for a single selection matching the open reading-pane item —
 *     a failed unload redirects Office.context.mailbox.item to the loaded
 *     item until the taskpane reloads (the "frozen after Add email(s)" bug).
 *   - unloadAsync failures must be retried, not swallowed.
 *   - Context reads are serialized behind the module's mailbox lock so they
 *     can't interleave with a load/unload cycle.
 */
/* global Office */

import '@testing-library/jest-dom';

const {
  fetchCurrentMailContext,
  fetchSelectedItemsContext
} = require('../../../client/src/features/office/utilities/outlookMailContext');

const SUCCEEDED = 'succeeded';
const FAILED = 'failed';

function installOfficeMock() {
  global.Office = {
    AsyncResultStatus: { Succeeded: SUCCEEDED, Failed: FAILED },
    CoercionType: { Text: 'text' },
    context: { mailbox: { item: null } }
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
function makeMailItem({ itemId, subject, bodyText, attachments = [], onBodyRead }) {
  const item = {
    itemId,
    itemType: 'message',
    subject,
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
  test('returns a full snapshot (subject, body, attachment content) for a stable item', async () => {
    const itemA = makeMailItem({
      itemId: 'A',
      subject: 'Mail A',
      bodyText: 'body of A',
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

describe('fetchSelectedItemsContext', () => {
  function installMultiSelectMocks({ stubs, loadedBodies = {}, unloadFailures = {} }) {
    const calls = { load: [], unload: [] };
    Office.context.mailbox.getSelectedItemsAsync = cb => {
      setTimeout(() => cb({ status: SUCCEEDED, value: stubs }), 0);
    };
    Office.context.mailbox.loadItemByIdAsync = (itemId, cb) => {
      calls.load.push(itemId);
      const loaded = {
        body: {
          getAsync: (_c, bodyCb) =>
            setTimeout(() => bodyCb({ status: SUCCEEDED, value: loadedBodies[itemId] ?? null }), 0)
        },
        unloadAsync: unloadCb => {
          calls.unload.push(itemId);
          const failuresLeft = unloadFailures[itemId] ?? 0;
          if (failuresLeft > 0) {
            unloadFailures[itemId] = failuresLeft - 1;
            setTimeout(() => unloadCb({ status: FAILED, error: { message: 'unload failed' } }), 0);
            return;
          }
          setTimeout(() => unloadCb({ status: SUCCEEDED }), 0);
        }
      };
      setTimeout(() => cb({ status: SUCCEEDED, value: loaded }), 0);
    };
    return calls;
  }

  test('skips loadItemByIdAsync entirely when the single selected email is the open one', async () => {
    Office.context.mailbox.item = makeMailItem({ itemId: 'A', subject: 'Mail A', bodyText: 'a' });
    const calls = installMultiSelectMocks({
      stubs: [{ itemId: 'A', subject: 'Mail A' }]
    });

    const out = await fetchSelectedItemsContext();

    expect(out).toEqual([]);
    expect(calls.load).toEqual([]);
    expect(calls.unload).toEqual([]);
  });

  test('loads and unloads each item sequentially for a real multi-selection', async () => {
    Office.context.mailbox.item = makeMailItem({ itemId: 'A', subject: 'Mail A', bodyText: 'a' });
    const calls = installMultiSelectMocks({
      stubs: [
        { itemId: 'A', subject: 'Mail A' },
        { itemId: 'B', subject: 'Mail B' }
      ],
      loadedBodies: { A: 'body A', B: 'body B' }
    });

    const out = await fetchSelectedItemsContext();

    expect(out).toEqual([
      { available: true, subject: 'Mail A', itemId: 'A', bodyText: 'body A', attachments: [] },
      { available: true, subject: 'Mail B', itemId: 'B', bodyText: 'body B', attachments: [] }
    ]);
    expect(calls.load).toEqual(['A', 'B']);
    expect(calls.unload).toEqual(['A', 'B']);
  });

  test('retries a failed unloadAsync so a wedged load cannot freeze the taskpane silently', async () => {
    Office.context.mailbox.item = makeMailItem({ itemId: 'A', subject: 'Mail A', bodyText: 'a' });
    const unloadFailures = { A: 1 }; // first unload of A fails, retry succeeds
    const calls = installMultiSelectMocks({
      stubs: [
        { itemId: 'A', subject: 'Mail A' },
        { itemId: 'B', subject: 'Mail B' }
      ],
      loadedBodies: { A: 'body A', B: 'body B' },
      unloadFailures
    });

    const out = await fetchSelectedItemsContext();

    expect(out).toHaveLength(2);
    // A unloaded twice (fail + retry), then B once.
    expect(calls.unload).toEqual(['A', 'A', 'B']);
  });

  test('takes the load path for a single selection that does NOT match the open item', async () => {
    Office.context.mailbox.item = makeMailItem({ itemId: 'X', subject: 'Other', bodyText: 'x' });
    const calls = installMultiSelectMocks({
      stubs: [{ itemId: 'A', subject: 'Mail A' }],
      loadedBodies: { A: 'body A' }
    });

    const out = await fetchSelectedItemsContext();

    expect(out).toEqual([
      { available: true, subject: 'Mail A', itemId: 'A', bodyText: 'body A', attachments: [] }
    ]);
    expect(calls.load).toEqual(['A']);
    expect(calls.unload).toEqual(['A']);
  });
});

describe('mailbox access serialization', () => {
  test('a context read queued during a multi-select load waits for the unload to finish', async () => {
    const order = [];
    const itemA = makeMailItem({
      itemId: 'A',
      subject: 'Mail A',
      bodyText: 'body of A',
      onBodyRead: () => order.push('context-body-read')
    });
    Office.context.mailbox.item = itemA;

    Office.context.mailbox.getSelectedItemsAsync = cb => {
      setTimeout(
        () =>
          cb({
            status: SUCCEEDED,
            value: [
              { itemId: 'B', subject: 'Mail B' },
              { itemId: 'C', subject: 'Mail C' }
            ]
          }),
        0
      );
    };
    Office.context.mailbox.loadItemByIdAsync = (itemId, cb) => {
      order.push(`load:${itemId}`);
      const loaded = {
        body: {
          getAsync: (_c, bodyCb) => setTimeout(() => bodyCb({ status: SUCCEEDED, value: 'b' }), 5)
        },
        unloadAsync: unloadCb => {
          setTimeout(() => {
            order.push(`unload:${itemId}`);
            unloadCb({ status: SUCCEEDED });
          }, 5);
        }
      };
      setTimeout(() => cb({ status: SUCCEEDED, value: loaded }), 5);
    };

    const multiPromise = fetchSelectedItemsContext();
    const contextPromise = fetchCurrentMailContext();
    await Promise.all([multiPromise, contextPromise]);

    // The current-mail read must not interleave with the load/unload cycle:
    // its first host call happens only after the final unload completed.
    const lastUnload = order.lastIndexOf('unload:C');
    const bodyRead = order.indexOf('context-body-read');
    expect(lastUnload).toBeGreaterThanOrEqual(0);
    expect(bodyRead).toBeGreaterThan(lastUnload);
  });
});
