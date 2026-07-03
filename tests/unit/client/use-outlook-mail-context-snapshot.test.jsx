/**
 * Unit tests for client/src/features/office/hooks/useOutlookMailContextSnapshot.js
 *
 * Regression coverage for the stale-attachment bug: a single click in
 * Outlook fires both ItemChanged and SelectedItemsChanged (both dispatch
 * 'ihub:itemchanged'), so context loads overlap. The hook must
 *   - publish only the NEWEST load's result (a slow stale load resolving
 *     last must not clobber the fresh snapshot),
 *   - coalesce the double dispatch into a single re-fetch,
 *   - reset per-email edits (removed attachments, include-body) on change.
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
