// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { StrictMode } from 'react';
import { act, render, renderHook, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  describeAdminLoadError,
  useAdminConfigLoad
} from '../../../client/src/features/admin/hooks/useAdminConfigLoad';
import AdminLoadGate from '../../../client/src/features/admin/components/AdminLoadGate';

/**
 * useAdminConfigLoad + AdminLoadGate: a settings page shows its form only once
 * the data it saves has loaded; a failed required load shows the error with an
 * in-place Retry instead (ID-B1, IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5).
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''))
        : key,
    i18n: { language: 'en' }
  })
}));

// The real module pulls in the axios client (import.meta); keep its error reading.
jest.mock('../../../client/src/api/adminApi', () => ({
  getAdminApiErrorMessage: err =>
    err?.response?.data?.detail || err?.message || 'An unexpected error occurred'
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span />
}));

/** A promise that the test settles by hand, to control the order of responses. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An axios-like error with an HTTP status, a problem+json body and headers. */
function httpError(status, { detail = 'Request failed', code, headers = {} } = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { detail, code, status }, headers };
  return err;
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('useAdminConfigLoad', () => {
  it('is loading until every required source answered, then ready with their data', async () => {
    const platform = deferred();
    const { result } = renderHook(() =>
      useAdminConfigLoad({ sources: { platform: { load: () => platform.promise } } })
    );

    expect(result.current.status).toBe('loading');

    await act(async () => platform.resolve({ auth: { mode: 'local' } }));

    expect(result.current.status).toBe('ready');
    expect(result.current.data.platform).toEqual({ auth: { mode: 'local' } });
    expect(result.current.errors).toEqual({});
  });

  it('fails when a required source fails, and says why', async () => {
    const { result } = renderHook(() =>
      useAdminConfigLoad({
        sources: {
          platform: { load: () => Promise.reject(httpError(500, { detail: 'Disk on fire' })) }
        }
      })
    );
    await flush();

    expect(result.current.status).toBe('failed');
    expect(result.current.error).toMatchObject({ status: 500, detail: 'Disk on fire' });
    expect(result.current.errors.platform).toMatchObject({ status: 500 });
  });

  it('stays ready when only an optional source fails, and reports it in errors', async () => {
    const { result } = renderHook(() =>
      useAdminConfigLoad({
        sources: {
          platform: { load: () => Promise.resolve({ ok: true }) },
          groups: { required: false, load: () => Promise.reject(httpError(503)) }
        }
      })
    );
    await flush();

    expect(result.current.status).toBe('ready');
    expect(result.current.errors.groups).toMatchObject({ status: 503 });
    expect(result.current.error).toBeNull();
  });

  it('retry() re-runs only the sources that failed', async () => {
    const platformLoad = jest.fn().mockResolvedValue({ ok: true });
    const auditLoad = jest
      .fn()
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ anonymizeIp: 'mask' });
    const { result } = renderHook(() =>
      useAdminConfigLoad({
        sources: { platform: { load: platformLoad }, audit: { load: auditLoad } }
      })
    );
    await flush();
    expect(result.current.status).toBe('failed');

    await act(async () => {
      await result.current.retry();
    });

    expect(platformLoad).toHaveBeenCalledTimes(1);
    expect(auditLoad).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ready');
    expect(result.current.data.audit).toEqual({ anonymizeIp: 'mask' });
  });

  it('keeps the error shown (status failed, retrying true) while a retry runs', async () => {
    const second = deferred();
    const load = jest
      .fn()
      .mockRejectedValueOnce(httpError(500))
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useAdminConfigLoad({ sources: { platform: { load } } }));
    await flush();

    let retryPromise;
    act(() => {
      retryPromise = result.current.retry();
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.retrying).toBe(true);

    await act(async () => {
      second.resolve({ ok: true });
      await retryPromise;
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.retrying).toBe(false);
  });

  it('ignores a stale response that resolves after a newer one', async () => {
    // StrictMode mounts, unmounts and re-mounts: two requests for one source are
    // in flight. The older one answering last must not overwrite the newer data.
    const older = deferred();
    const newer = deferred();
    const onLoad = jest.fn();
    const load = jest.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(
      () => useAdminConfigLoad({ sources: { platform: { load, onLoad } } }),
      { wrapper: StrictMode }
    );
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => newer.resolve({ v: 'newer' }));
    await act(async () => older.resolve({ v: 'older' }));

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith({ v: 'newer' });
    expect(result.current.data.platform).toEqual({ v: 'newer' });
  });

  it('ignores a stale failure that arrives after a newer success', async () => {
    const older = deferred();
    const newer = deferred();
    const load = jest.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useAdminConfigLoad({ sources: { platform: { load } } }), {
      wrapper: StrictMode
    });

    await act(async () => newer.resolve({ ok: true }));
    await act(async () => older.reject(httpError(500)));

    expect(result.current.status).toBe('ready');
    expect(result.current.errors).toEqual({});
  });

  it('does not set state after unmount', async () => {
    const pending = deferred();
    const onLoad = jest.fn();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() =>
      useAdminConfigLoad({ sources: { platform: { load: () => pending.promise, onLoad } } })
    );
    unmount();
    await act(async () => pending.resolve({ ok: true }));

    expect(onLoad).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  describe('Retry-After', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('reads Retry-After from a 429 and counts it down; retry() waits for it', async () => {
      const load = jest
        .fn()
        .mockRejectedValueOnce(
          httpError(429, { code: 'RATE_LIMITED', headers: { 'retry-after': '3' } })
        )
        .mockResolvedValueOnce({ ok: true });
      const { result } = renderHook(() => useAdminConfigLoad({ sources: { platform: { load } } }));
      await flush();

      expect(result.current.error).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
      expect(result.current.retryAfterSeconds).toBe(3);

      await act(async () => {
        await result.current.retry();
      });
      expect(load).toHaveBeenCalledTimes(1); // too early

      act(() => jest.advanceTimersByTime(1000));
      expect(result.current.retryAfterSeconds).toBe(2);
      act(() => jest.advanceTimersByTime(1000));
      act(() => jest.advanceTimersByTime(1000));
      expect(result.current.retryAfterSeconds).toBe(0);

      await act(async () => {
        await result.current.retry();
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe('ready');
    });
  });
});

describe('describeAdminLoadError', () => {
  it('reads Retry-After from the problem+json body when the header is missing', () => {
    const err = httpError(429);
    err.response.data.retryAfter = 7;
    expect(describeAdminLoadError(err).retryAfterSeconds).toBe(7);
  });

  it('falls back to 10 s for a 429 without any Retry-After', () => {
    expect(describeAdminLoadError(httpError(429)).retryAfterSeconds).toBe(10);
  });

  it('has no wait and no status for a network error', () => {
    expect(describeAdminLoadError(new Error('Network Error'))).toEqual({
      status: null,
      code: null,
      detail: 'Network Error',
      retryAfterSeconds: null
    });
  });
});

describe('AdminLoadGate', () => {
  function Page({ sources }) {
    const load = useAdminConfigLoad({ sources });
    return (
      <AdminLoadGate load={load} resourceLabel="authentication settings">
        {() => <button type="button">Save</button>}
      </AdminLoadGate>
    );
  }

  it('renders no form while a required load failed, and the form after Retry', async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(httpError(500, { detail: 'Boom' }))
      .mockResolvedValueOnce({ ok: true });
    render(<Page sources={{ platform: { load } }} />);
    await flush();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load authentication settings");
    expect(alert).toHaveTextContent('Boom Nothing was changed.');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await flush();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('shows "You can\'t view" without Retry for a 403', async () => {
    render(<Page sources={{ platform: { load: () => Promise.reject(httpError(403)) } }} />);
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent("You can't view authentication settings");
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('disables Retry with a countdown after a 429', async () => {
    jest.useFakeTimers();
    try {
      render(
        <Page
          sources={{
            platform: {
              load: () => Promise.reject(httpError(429, { headers: { 'retry-after': '12' } }))
            }
          }}
        />
      );
      await flush();

      const button = screen.getByRole('button', { name: 'Retry in 12 s' });
      expect(button).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent('Too many requests right now.');
    } finally {
      jest.useRealTimers();
    }
  });
});
