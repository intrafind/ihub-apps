// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A sign-in refusal from /api/health must not count as "offline".
 *
 * Bug: the health check treated any non-2xx answer as offline and then polled
 * /api/health every 5–30 seconds for as long as the tab was open. Behind
 * Windows sign-in with a stale password every poll was another failed logon,
 * which kept the user's AD account locked.
 */
import { render, act } from '@testing-library/react';

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`
}));
import {
  NetworkStatusProvider,
  useNetworkStatus,
  isReachableStatus
} from '../../../client/src/shared/hooks/useNetworkStatus';

test('only a 5xx answer means the server is unreachable', () => {
  expect(isReachableStatus(200)).toBe(true);
  expect(isReachableStatus(401)).toBe(true);
  expect(isReachableStatus(403)).toBe(true);
  expect(isReachableStatus(429)).toBe(true);
  expect(isReachableStatus(500)).toBe(false);
  expect(isReachableStatus(503)).toBe(false);
});

describe('NetworkStatusProvider', () => {
  const originalFetch = global.fetch;
  let status;

  function Probe() {
    status = useNetworkStatus();
    return null;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  test('stays online and does not poll when the health check is refused with 403', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 403, ok: false });

    render(
      <NetworkStatusProvider>
        <Probe />
      </NetworkStatusProvider>
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60000);
    });

    expect(status.isOnline).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('goes offline and polls when the server answers 503', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 503, ok: false });

    render(
      <NetworkStatusProvider>
        <Probe />
      </NetworkStatusProvider>
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20000);
    });

    expect(status.isOnline).toBe(false);
    expect(global.fetch.mock.calls.length).toBeGreaterThan(1);
  });
});
