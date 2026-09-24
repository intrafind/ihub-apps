/**
 * Unit tests for client/src/features/office/hooks/useOutlookMailContextSnapshot.js
 *
 * Regression coverage for the stale-attachment bug: a single click in
 * Outlook fires both ItemChanged and SelectedItemsChanged (both dispatch
 * 'ihub:itemchanged'), so context loads overlap. The hook must
 *   - publish only the NEWEST load's result (a slow stale load resolving
 *     last must not clobber the fresh snapshot),
 *   - coalesce the double dispatch into a single re-fetch,
 *   - reset per-email edits (removed attachments, include-body) when the
 *     item changes, and keep them for events about the same item.
 */

import '@testing-library/jest-dom';
import { renderHook, act } from '@testing-library/react';

let mockHostImpl;
jest.mock('../../../client/src/features/office/contexts/EmbeddedHostContext', () => ({
  useEmbeddedHost: () => mockHostImpl
}));

const useOutlookMailContextSnapshot =
  require('../../../client/src/features/office/hooks/useOutlookMailContextSnapshot').default;

function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function dispatchItemChanged() {
  document.dispatchEvent(new CustomEvent('ihub:itemchanged'));
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('a stale slow load must not clobber the fresh snapshot (last-writer race)', async () => {
  const loads = [];
  mockHostImpl = {
    kind: 'office',
    readMessageContext: jest.fn(() => {
      const d = deferred();
      loads.push(d);
      return d.promise;
    })
  };

  const { result } = renderHook(() => useOutlookMailContextSnapshot());
  expect(result.current.loading).toBe(true);
  expect(loads).toHaveLength(1); // mount load (email A) — kept pending: it is slow

  // User clicks email B: Outlook fires ItemChanged AND SelectedItemsChanged.
  await act(async () => {
    dispatchItemChanged();
    dispatchItemChanged();
  });

  // Double dispatch coalesces into ONE re-fetch after the debounce window.
  await act(async () => {
    jest.advanceTimersByTime(150);
  });
  expect(loads).toHaveLength(2);

  // Fresh load (email B) resolves first…
  const ctxB = { available: true, itemId: 'B', subject: 'Mail B', attachments: [] };
  await act(async () => {
    loads[1].resolve(ctxB);
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.ctx).toEqual(ctxB);

  // …then the stale mount load (email A) finally resolves. It must be ignored.
  const ctxA = {
    available: true,
    itemId: 'A',
    subject: 'Mail A',
    attachments: [{ id: 'a1', name: 'old.pdf', error: 'The attachment identifier does not exist.' }]
  };
  await act(async () => {
    loads[0].resolve(ctxA);
  });
  expect(result.current.ctx).toEqual(ctxB);
  expect(result.current.loading).toBe(false);
});

test('rapid successive item changes: only the newest load publishes', async () => {
  const loads = [];
  mockHostImpl = {
    kind: 'office',
    readMessageContext: jest.fn(() => {
      const d = deferred();
      loads.push(d);
      return d.promise;
    })
  };

  const { result } = renderHook(() => useOutlookMailContextSnapshot());
  await act(async () => {
    loads[0].resolve({ available: true, itemId: 'A', subject: 'Mail A', attachments: [] });
  });
  expect(result.current.ctx?.itemId).toBe('A');

  // Switch to B, then to C before B's load resolves.
  await act(async () => {
    dispatchItemChanged();
    jest.advanceTimersByTime(150);
  });
  expect(loads).toHaveLength(2);

  await act(async () => {
    dispatchItemChanged();
    jest.advanceTimersByTime(150);
  });
  expect(loads).toHaveLength(3);

  // B's (superseded) load resolves late — must be dropped, still loading C.
  await act(async () => {
    loads[1].resolve({ available: true, itemId: 'B', subject: 'Mail B', attachments: [] });
  });
  expect(result.current.loading).toBe(true);
  expect(result.current.ctx).toBeNull();

  await act(async () => {
    loads[2].resolve({ available: true, itemId: 'C', subject: 'Mail C', attachments: [] });
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.ctx?.itemId).toBe('C');
});

test('per-email edits (removed attachments, include-body) reset on item change', async () => {
  const loads = [];
  mockHostImpl = {
    kind: 'office',
    readMessageContext: jest.fn(() => {
      const d = deferred();
      loads.push(d);
      return d.promise;
    })
  };

  const { result } = renderHook(() => useOutlookMailContextSnapshot());
  await act(async () => {
    loads[0].resolve({
      available: true,
      itemId: 'A',
      subject: 'Mail A',
      attachments: [{ id: 'a1', name: 'doc.pdf' }]
    });
  });

  act(() => {
    result.current.removeAttachment('a1');
    result.current.setIncludeBody(false);
  });
  expect(result.current.removedAttachmentIds.has('a1')).toBe(true);
  expect(result.current.includeBody).toBe(false);
  const generationBefore = result.current.generation;

  await act(async () => {
    dispatchItemChanged();
  });
  expect(result.current.removedAttachmentIds.size).toBe(0);
  expect(result.current.includeBody).toBe(true);
  expect(result.current.generation).toBe(generationBefore + 1);
});

test('an event for the email already open keeps the per-email edits (issue #2450)', async () => {
  global.Office = { context: { mailbox: { item: { itemId: 'A' } } } };
  try {
    const loads = [];
    mockHostImpl = {
      kind: 'office',
      readMessageContext: jest.fn(() => {
        const d = deferred();
        loads.push(d);
        return d.promise;
      })
    };

    const { result } = renderHook(() => useOutlookMailContextSnapshot());
    await act(async () => {
      loads[0].resolve({
        available: true,
        itemId: 'A',
        attachments: [{ id: 'a1', name: 'doc.pdf' }]
      });
    });
    act(() => {
      result.current.removeAttachment('a1');
      result.current.setIncludeBody(false);
    });

    // Re-selecting the same message / a list refresh.
    await act(async () => {
      dispatchItemChanged();
    });
    expect(result.current.removedAttachmentIds.has('a1')).toBe(true);
    expect(result.current.includeBody).toBe(false);

    // A genuinely different email still starts clean.
    global.Office.context.mailbox.item = { itemId: 'B' };
    await act(async () => {
      dispatchItemChanged();
    });
    expect(result.current.removedAttachmentIds.size).toBe(0);
    expect(result.current.includeBody).toBe(true);
  } finally {
    delete global.Office;
  }
});

function dispatchSelectionChanged() {
  document.dispatchEvent(
    new CustomEvent('ihub:itemchanged', { detail: { source: 'SelectedItemsChanged' } })
  );
}

function dispatchOutlookItemChanged() {
  document.dispatchEvent(
    new CustomEvent('ihub:itemchanged', { detail: { source: 'ItemChanged' } })
  );
}

function mailCtx(itemId) {
  return { available: true, itemId, subject: `Mail ${itemId}`, attachments: [] };
}

const NO_ITEM = { available: false, reason: 'no item', attachments: [] };

describe('switching emails', () => {
  let loads;

  beforeEach(() => {
    global.Office = { context: { mailbox: { item: { itemId: 'A' } } } };
    loads = [];
    mockHostImpl = {
      kind: 'office',
      readMessageContext: jest.fn(() => {
        const d = deferred();
        loads.push(d);
        return d.promise;
      })
    };
  });

  afterEach(() => {
    delete global.Office;
  });

  async function mountWithEmailA() {
    const hook = renderHook(() => useOutlookMailContextSnapshot());
    await act(async () => {
      loads[0].resolve(mailCtx('A'));
    });
    expect(hook.result.current.ctx?.itemId).toBe('A');
    return hook;
  }

  test('SelectedItemsChanged reads in the background and shows the new email once the read returns it', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatchSelectionChanged();
    });
    // The strip keeps A while the read runs — no blank "Email context".
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('A');

    await act(async () => {
      jest.advanceTimersByTime(150);
    });
    expect(loads).toHaveLength(2);

    await act(async () => {
      loads[1].resolve(mailCtx('B'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('B');

    // A settled read of a different email needs no verification read.
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(loads).toHaveLength(2);
  });

  test('regression: the pane switches even when mailbox.item.itemId still names the old email', async () => {
    const { result } = await mountWithEmailA();
    act(() => {
      result.current.removeAttachment('a1');
      result.current.setIncludeBody(false);
    });

    // The user clicks B. Outlook fires both events while the synchronous
    // item id still says A (the host hands out the cached previous item).
    await act(async () => {
      dispatchSelectionChanged();
      dispatchOutlookItemChanged();
      jest.advanceTimersByTime(150);
    });
    expect(result.current.loading).toBe(true);
    expect(loads).toHaveLength(2);

    // The read itself already runs against the new email.
    await act(async () => {
      loads[1].resolve(mailCtx('B'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('B');
    // The edits belonged to A and are gone with it.
    expect(result.current.removedAttachmentIds.size).toBe(0);
    expect(result.current.includeBody).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(loads).toHaveLength(2);
  });

  test('a read that still returned the previous email is verified once more', async () => {
    const { result } = await mountWithEmailA();

    // ItemChanged fires, but the read lands before the host swapped the item
    // and returns A again.
    await act(async () => {
      dispatchOutlookItemChanged();
      jest.advanceTimersByTime(150);
    });
    expect(loads).toHaveLength(2);
    await act(async () => {
      loads[1].resolve(mailCtx('A'));
    });
    // Not shown yet: the pane waits for the verification read…
    expect(result.current.loading).toBe(true);
    expect(loads).toHaveLength(2);

    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(loads).toHaveLength(3);
    await act(async () => {
      loads[2].resolve(mailCtx('B'));
    });
    // …which brings the email the user actually selected.
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('B');
  });

  test('ItemChanged for the same email publishes it after the verification read', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatchOutlookItemChanged();
      jest.advanceTimersByTime(150);
      loads[1].resolve(mailCtx('A'));
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(loads).toHaveLength(3);
    await act(async () => {
      loads[2].resolve(mailCtx('A'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('A');
    // The budget is spent: no further reads.
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(loads).toHaveLength(3);
  });

  test('re-selecting the open email or a list refresh changes nothing on screen', async () => {
    const { result } = await mountWithEmailA();
    const shown = result.current.ctx;
    act(() => {
      result.current.removeAttachment('a1');
    });

    await act(async () => {
      dispatchSelectionChanged();
      dispatchSelectionChanged();
      jest.advanceTimersByTime(150);
    });
    // The burst costs one background read…
    expect(loads).toHaveLength(2);
    expect(result.current.loading).toBe(false);
    await act(async () => {
      loads[1].resolve(mailCtx('A'));
    });
    // …plus one verification read, since the result looks like a stale one.
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(loads).toHaveLength(3);
    await act(async () => {
      loads[2].resolve(mailCtx('A'));
      jest.advanceTimersByTime(2000);
    });
    expect(loads).toHaveLength(3);
    // Same email: the snapshot object and the edits are untouched.
    expect(result.current.ctx).toBe(shown);
    expect(result.current.loading).toBe(false);
    expect(result.current.removedAttachmentIds.has('a1')).toBe(true);
  });

  test('a brief gap with no item during the switch does not blank the strip', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatchSelectionChanged();
      jest.advanceTimersByTime(150);
    });
    // The read lands mid-swap and finds no item.
    await act(async () => {
      loads[1].resolve(NO_ITEM);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('A');

    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(loads).toHaveLength(3);
    await act(async () => {
      loads[2].resolve(mailCtx('B'));
    });
    expect(result.current.ctx?.itemId).toBe('B');
  });

  test('when the item is really gone (deselect, multi-select) the verified empty state is shown', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatchSelectionChanged();
      jest.advanceTimersByTime(150);
      loads[1].resolve(NO_ITEM);
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(loads).toHaveLength(3);
    await act(async () => {
      loads[2].resolve(NO_ITEM);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx).toEqual(NO_ITEM);
  });

  test('a newer event supersedes a pending verification read', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatchSelectionChanged();
      jest.advanceTimersByTime(150);
      loads[1].resolve(mailCtx('A'));
    });
    // Verification pending (400 ms). ItemChanged arrives first.
    await act(async () => {
      jest.advanceTimersByTime(100);
      dispatchOutlookItemChanged();
      jest.advanceTimersByTime(150);
    });
    expect(loads).toHaveLength(3);
    await act(async () => {
      loads[2].resolve(mailCtx('B'));
    });
    expect(result.current.ctx?.itemId).toBe('B');
    // The superseded verification never ran.
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(loads).toHaveLength(3);
  });
});
