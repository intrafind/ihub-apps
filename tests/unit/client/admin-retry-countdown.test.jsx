// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { useRetryCountdown } from '../../../client/src/features/admin/hooks/useRetryCountdown';
import AdminEditPageShell from '../../../client/src/shared/components/AdminEditPageShell';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''))
        : key,
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span />
}));

/**
 * The Retry-After countdown of the App/Model editors and the Overview banner
 * (R6): a 429 load error makes Retry wait; other errors do not.
 */
describe('useRetryCountdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const tick = async seconds => {
    for (let i = 0; i < seconds; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }
  };

  it('is 0 without an error and for an error without a wait', () => {
    const { result, rerender } = renderHook(({ error }) => useRetryCountdown(error), {
      initialProps: { error: null }
    });
    expect(result.current).toBe(0);

    rerender({ error: { status: 500, retryAfterSeconds: null } });
    expect(result.current).toBe(0);
  });

  it('counts a 429 wait down to 0 once a second', async () => {
    // A stable object, like the error state the pages pass.
    const error = { status: 429, retryAfterSeconds: 3 };
    const { result } = renderHook(() => useRetryCountdown(error));
    expect(result.current).toBe(3);

    await tick(1);
    expect(result.current).toBe(2);
    await tick(2);
    expect(result.current).toBe(0);
  });

  it('starts a new wait when a new 429 arrives', async () => {
    const { result, rerender } = renderHook(({ error }) => useRetryCountdown(error), {
      initialProps: { error: { status: 429, retryAfterSeconds: 2 } }
    });
    await tick(2);
    expect(result.current).toBe(0);

    rerender({ error: { status: 429, retryAfterSeconds: 4 } });
    expect(result.current).toBe(4);
  });
});

describe('AdminEditPageShell after a 429 (App and Model editors)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('makes Retry wait for Retry-After before it loads again', async () => {
    const onRetry = jest.fn();
    const loadError = { status: 429, code: 'RATE_LIMITED', detail: 'x', retryAfterSeconds: 2 };
    render(
      <MemoryRouter>
        <AdminEditPageShell
          loading={false}
          loadError={loadError}
          onRetry={onRetry}
          resourceLabel="the app"
          blocker={{ state: 'unblocked', proceed: jest.fn(), reset: jest.fn() }}
        >
          <form />
        </AdminEditPageShell>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry in 2 s' }));
    expect(onRetry).not.toHaveBeenCalled();

    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
