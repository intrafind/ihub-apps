// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The estimate button's state: a result that arrives after the project
 * changed or after a newer run is dropped, and `clear` drops it too.
 */
import { renderHook, act } from '@testing-library/react';
import { useProjectEstimate } from '../../../client/src/features/projects/hooks/useProjectEstimate';

const message = err => err.message;

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useProjectEstimate', () => {
  test('keeps the result and indexes it by item', async () => {
    const call = jest.fn().mockResolvedValue({ items: [{ id: 'a', tokens: 3 }] });
    const { result } = renderHook(() => useProjectEstimate(call, message));

    await act(() => result.current.run());

    expect(result.current.estimate.items).toHaveLength(1);
    expect(result.current.byItem.a.tokens).toBe(3);
    expect(result.current.loading).toBe(false);
  });

  test('drops a result that arrives after the project changed', async () => {
    const slow = deferred();
    const first = jest.fn(() => slow.promise);
    const second = jest.fn().mockResolvedValue({ items: [] });
    const { result, rerender } = renderHook(({ call }) => useProjectEstimate(call, message), {
      initialProps: { call: first }
    });

    let running;
    act(() => {
      running = result.current.run();
    });
    rerender({ call: second });
    await act(async () => {
      slow.resolve({ items: [{ id: 'old' }] });
      await running;
    });

    expect(result.current.estimate).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  test('clear drops the result and a run still in flight', async () => {
    const slow = deferred();
    const call = jest.fn(() => slow.promise);
    const { result } = renderHook(() => useProjectEstimate(call, message));

    let running;
    act(() => {
      running = result.current.run();
    });
    act(() => result.current.clear());
    await act(async () => {
      slow.resolve({ items: [{ id: 'stale' }] });
      await running;
    });

    expect(result.current.estimate).toBeNull();
  });

  test('reports an error and no result', async () => {
    const call = jest.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useProjectEstimate(call, message));

    await act(() => result.current.run());

    expect(result.current.error).toBe('boom');
    expect(result.current.estimate).toBeNull();
  });
});
