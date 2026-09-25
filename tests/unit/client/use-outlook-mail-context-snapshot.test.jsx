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

function mailCtx(itemId, attachments = []) {
  return { available: true, itemId, subject: `Mail ${itemId}`, attachments };
}

const NO_ITEM = { available: false, reason: 'no item', attachments: [] };

describe('per-email edits', () => {
  let loads;

  beforeEach(() => {
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

  async function mountWithEmailA() {
    const hook = renderHook(() => useOutlookMailContextSnapshot());
    await act(async () => {
      loads[0].resolve(mailCtx('A', [{ id: 'a1', name: 'doc.pdf' }]));
    });
    expect(hook.result.current.ctx?.itemId).toBe('A');
    act(() => {
      hook.result.current.removeAttachment('a1');
      hook.result.current.setIncludeBody(false);
    });
    expect(hook.result.current.removedAttachmentIds.has('a1')).toBe(true);
    expect(hook.result.current.includeBody).toBe(false);
    return hook;
  }

  async function reloadReturning(ctx) {
    await act(async () => {
      dispatchItemChanged();
      jest.advanceTimersByTime(150);
    });
    await act(async () => {
      loads[loads.length - 1].resolve(ctx);
    });
  }

  test('reset when the read returns a different email', async () => {
    const { result } = await mountWithEmailA();
    const generationBefore = result.current.generation;

    await reloadReturning(mailCtx('B'));

    expect(result.current.ctx?.itemId).toBe('B');
    expect(result.current.removedAttachmentIds.size).toBe(0);
    expect(result.current.includeBody).toBe(true);
    expect(result.current.generation).toBeGreaterThan(generationBefore);
  });

  test('survive an event for the email already open (issue #2450)', async () => {
    const { result } = await mountWithEmailA();
    const generationBefore = result.current.generation;

    // Re-selecting the open email / a list refresh: the read returns A again.
    await reloadReturning(mailCtx('A', [{ id: 'a1', name: 'doc.pdf' }]));

    expect(result.current.ctx?.itemId).toBe('A');
    expect(result.current.removedAttachmentIds.has('a1')).toBe(true);
    expect(result.current.includeBody).toBe(false);
    expect(result.current.generation).toBe(generationBefore);
  });

  test('reset when the read finds no item at all (deselect, multi-select)', async () => {
    const { result } = await mountWithEmailA();

    await reloadReturning(NO_ITEM);

    expect(result.current.ctx?.itemId).toBeUndefined();
    expect(result.current.removedAttachmentIds.size).toBe(0);
    expect(result.current.includeBody).toBe(true);
  });
});

describe('switching emails', () => {
  let loads;

  beforeEach(() => {
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

  async function mountWithEmailA() {
    const hook = renderHook(() => useOutlookMailContextSnapshot());
    await act(async () => {
      loads[0].resolve(mailCtx('A'));
    });
    expect(hook.result.current.ctx?.itemId).toBe('A');
    return hook;
  }

  // The regression behind #2470/#2505/#2509: every one of those gated the
  // re-read (or its publication) on `Office.context.mailbox.item.itemId`,
  // which Outlook keeps pointing at the previous email for a while after the
  // switch. With a lagging id the gate said "same item" and the pane stayed
  // on the old email — permanently, because nothing retried. The hook must
  // not consult that id at all.
  test('switches even when mailbox.item.itemId still names the old email', async () => {
    global.Office = { context: { mailbox: { item: { itemId: 'A' } } } };
    try {
      const { result } = await mountWithEmailA();

      await act(async () => {
        dispatchItemChanged();
        jest.advanceTimersByTime(150);
      });
      expect(loads).toHaveLength(2);

      await act(async () => {
        loads[1].resolve(mailCtx('B'));
      });
      expect(result.current.ctx?.itemId).toBe('B');
    } finally {
      delete global.Office;
    }
  });

  // ItemChanged then SelectedItemsChanged is what Outlook desktop fires for
  // one click. #2509 cancelled the first load and let the second one decline
  // to publish, leaving the hook stuck at { loading: true, ctx: null }.
  test.each([
    ['ItemChanged then SelectedItemsChanged', ['ItemChanged', 'SelectedItemsChanged']],
    ['SelectedItemsChanged then ItemChanged', ['SelectedItemsChanged', 'ItemChanged']]
  ])('%s coalesces into one read that publishes', async (_name, sources) => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      for (const source of sources) {
        document.dispatchEvent(new CustomEvent('ihub:itemchanged', { detail: { source } }));
      }
      jest.advanceTimersByTime(150);
    });
    expect(loads).toHaveLength(2);

    await act(async () => {
      loads[1].resolve(mailCtx('B'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('B');
  });

  // No id gate means no way to get wedged: even a read that comes back with
  // the old email publishes, so the next event starts from a settled state
  // instead of an indefinite loading one.
  test('a read that returned the old email still publishes', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatchItemChanged();
      jest.advanceTimersByTime(150);
    });
    await act(async () => {
      loads[1].resolve(mailCtx('A'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('A');

    // And the next event reads again, rather than being gated away.
    await act(async () => {
      dispatchItemChanged();
      jest.advanceTimersByTime(150);
    });
    expect(loads).toHaveLength(3);
    await act(async () => {
      loads[2].resolve(mailCtx('B'));
    });
    expect(result.current.ctx?.itemId).toBe('B');
  });

  test('no extra verification reads are scheduled', async () => {
    await mountWithEmailA();

    await act(async () => {
      dispatchItemChanged();
      jest.advanceTimersByTime(150);
    });
    await act(async () => {
      loads[1].resolve(mailCtx('A'));
    });

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(loads).toHaveLength(2);
  });
});

// Outlook for Mac fires SelectedItemsChanged first and ItemChanged a moment
// later for one click. Treating both as a reload blanked the strip twice and
// repainted the old email in between, so the switch felt like a full reload.
describe('SelectedItemsChanged is a quiet check', () => {
  let loads;

  beforeEach(() => {
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

  function dispatch(source) {
    document.dispatchEvent(new CustomEvent('ihub:itemchanged', { detail: { source } }));
  }

  async function mountWithEmailA() {
    const hook = renderHook(() => useOutlookMailContextSnapshot());
    await act(async () => {
      loads[0].resolve(mailCtx('A'));
    });
    return hook;
  }

  test('never blanks the strip, and a read of the email already shown changes nothing', async () => {
    const { result } = await mountWithEmailA();
    const shown = result.current.ctx;

    await act(async () => {
      dispatch('SelectedItemsChanged');
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx).toBe(shown);

    await act(async () => {
      jest.advanceTimersByTime(150);
    });
    expect(loads).toHaveLength(2);
    await act(async () => {
      loads[1].resolve(mailCtx('A'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx).toBe(shown);
  });

  test('swaps straight to a different email the quiet read found (multi-select hosts)', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatch('SelectedItemsChanged');
      jest.advanceTimersByTime(150);
    });
    await act(async () => {
      loads[1].resolve(mailCtx('B'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('B');
  });

  test('the Mac sequence — quiet check, then ItemChanged — shows the new email once', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatch('SelectedItemsChanged');
      jest.advanceTimersByTime(150);
    });
    await act(async () => {
      loads[1].resolve(mailCtx('A')); // mailbox.item has not moved yet
    });
    expect(result.current.ctx?.itemId).toBe('A');

    await act(async () => {
      dispatch('ItemChanged');
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(150);
    });
    await act(async () => {
      loads[2].resolve(mailCtx('B'));
    });
    expect(result.current.ctx?.itemId).toBe('B');
  });

  test('a quiet read that supersedes a visible one still ends the loading state', async () => {
    const { result } = await mountWithEmailA();

    await act(async () => {
      dispatch('ItemChanged');
      jest.advanceTimersByTime(150);
    });
    expect(loads).toHaveLength(2); // visible read in flight
    await act(async () => {
      dispatch('SelectedItemsChanged');
      jest.advanceTimersByTime(150);
    });
    expect(loads).toHaveLength(3);
    await act(async () => {
      loads[2].resolve(mailCtx('A'));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx?.itemId).toBe('A');
  });
});
