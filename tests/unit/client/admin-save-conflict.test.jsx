// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Optimistic locking of platform and UI config saves on the client (decision 6).
 *
 * `makeAdminApiCall` remembers the `ETag` of each read and successful write of
 * `/admin/configs/platform` and `/admin/ui/config`, sends it as `If-Match` on
 * the next POST of that file, and on `412 PRECONDITION_FAILED` raises one
 * conflict dialog. The dialog keeps the admin's edits (nothing on the page is
 * touched), offers Reload, and never retries.
 *
 * Also: the scoped saves (Advanced → onboarding toggle, Logging → privacy card)
 * send only their own fields.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockRequest = jest.fn();
jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: (...args) => mockRequest(...args)
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api${path}`
}));
jest.mock('../../../client/src/api/endpoints/projects.js', () => ({
  CRAWL_REQUEST_TIMEOUT_MS: 1000
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-name={name} />
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ refreshConfig: jest.fn() })
}));
jest.mock('../../../client/src/features/admin/components/AdminDemoAccountsAlert', () => ({
  __esModule: true,
  default: () => null
}));

const { makeAdminApiCall } = require('../../../client/src/api/adminApi');
const {
  CONFIG_CONFLICT_EVENT,
  resetConfigRevisions
} = require('../../../client/src/api/adminConfigRevision');
const AdminConfigConflictNotice =
  require('../../../client/src/features/admin/components/AdminConfigConflictNotice').default;
const AdminAdvancedPage =
  require('../../../client/src/features/admin/pages/AdminAdvancedPage').default;
const CookieSettingsConfig =
  require('../../../client/src/features/admin/components/CookieSettingsConfig').default;

const ok = (data, etag) => ({ status: 200, data, headers: etag ? { etag } : {} });
const conflict = () => {
  const error = new Error('Request failed with status code 412');
  error.response = {
    status: 412,
    data: {
      code: 'PRECONDITION_FAILED',
      status: 412,
      detail: 'changed',
      details: { resource: 'platform' }
    }
  };
  return error;
};
const sentHeaders = call => mockRequest.mock.calls[call][0].headers;

beforeEach(() => {
  mockRequest.mockReset();
  resetConfigRevisions();
  localStorage.clear();
});

describe('makeAdminApiCall: If-Match for platform and UI config saves', () => {
  test('a POST of the platform config sends the ETag of the last read', async () => {
    mockRequest.mockResolvedValueOnce(ok({}, '"rev-1"')).mockResolvedValueOnce(ok({}, '"rev-2"'));

    await makeAdminApiCall('/admin/configs/platform');
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: { a: 1 } });

    expect(sentHeaders(0)['If-Match']).toBeUndefined();
    expect(sentHeaders(1)['If-Match']).toBe('"rev-1"');
  });

  test('the ETag of a successful save is used for the next save (no re-read needed)', async () => {
    mockRequest
      .mockResolvedValueOnce(ok({}, '"rev-1"'))
      .mockResolvedValueOnce(ok({}, '"rev-2"'))
      .mockResolvedValueOnce(ok({}, '"rev-3"'));

    await makeAdminApiCall('/admin/configs/platform');
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {} });
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {} });

    expect(sentHeaders(2)['If-Match']).toBe('"rev-2"');
  });

  test('UI config and platform config keep separate revisions', async () => {
    mockRequest
      .mockResolvedValueOnce(ok({}, '"ui-1"'))
      .mockResolvedValueOnce(ok({}, '"platform-1"'))
      .mockResolvedValueOnce({ status: 204, data: '', headers: { etag: '"ui-2"' } });

    await makeAdminApiCall('/admin/ui/config');
    await makeAdminApiCall('/admin/configs/platform');
    await makeAdminApiCall('/admin/ui/config', { method: 'POST', body: { config: {} } });

    expect(sentHeaders(2)['If-Match']).toBe('"ui-1"');
  });

  test('scoped PATCH and other endpoints are not guarded', async () => {
    mockRequest.mockResolvedValue(ok({}, '"rev-1"'));

    await makeAdminApiCall('/admin/configs/platform');
    await makeAdminApiCall('/admin/configs/platform', { method: 'PATCH', body: { setup: {} } });
    await makeAdminApiCall('/admin/apps/x', { method: 'POST', body: {} });

    expect(sentHeaders(1)['If-Match']).toBeUndefined();
    expect(sentHeaders(2)['If-Match']).toBeUndefined();
  });

  test("a PATCH response does not advance the revision a full form's POST is checked against", async () => {
    // A full form (Authentication) loaded rev-1. Another admin then saved, and
    // a scoped PATCH from another card finished afterwards with rev-3. The
    // form never saw the other admin's change, so its POST must still send
    // rev-1 and be refused, not carry rev-3 and overwrite that change.
    mockRequest
      .mockResolvedValueOnce(ok({}, '"rev-1"'))
      .mockResolvedValueOnce(ok({}, '"rev-3"'))
      .mockResolvedValueOnce(ok({}, '"rev-4"'));

    await makeAdminApiCall('/admin/configs/platform');
    await makeAdminApiCall('/admin/configs/platform', {
      method: 'PATCH',
      body: { cookieSettings: { disableSecure: true } }
    });
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {} });

    expect(sentHeaders(2)['If-Match']).toBe('"rev-1"');
  });

  test('no read yet: no If-Match (the save behaves as before)', async () => {
    mockRequest.mockResolvedValueOnce(ok({}));
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {} });
    expect(sentHeaders(0)['If-Match']).toBeUndefined();
  });

  test('a 412 raises the conflict event once, is rethrown, and is not retried', async () => {
    const events = [];
    const listener = event => events.push(event.detail);
    window.addEventListener(CONFIG_CONFLICT_EVENT, listener);
    mockRequest.mockResolvedValueOnce(ok({}, '"rev-1"')).mockRejectedValueOnce(conflict());

    await makeAdminApiCall('/admin/configs/platform');
    await expect(
      makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {} })
    ).rejects.toMatchObject({ response: { status: 412 } });

    window.removeEventListener(CONFIG_CONFLICT_EVENT, listener);
    expect(events).toEqual([{ resource: 'platform' }]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});

describe('AdminConfigConflictNotice', () => {
  const raise = resource =>
    act(() => {
      window.dispatchEvent(new CustomEvent(CONFIG_CONFLICT_EVENT, { detail: { resource } }));
    });

  test('shows what happened and that the edits are still on the page', () => {
    render(<AdminConfigConflictNotice onReload={jest.fn()} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    raise('ui');

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('This changed since you opened it')).toBeInTheDocument();
    expect(screen.getByText(/saved the UI customization after you opened/)).toBeInTheDocument();
    expect(
      screen.getByText(/Your changes were not saved and are still on the page/)
    ).toBeInTheDocument();
  });

  test('"Keep my changes" closes the dialog, reloads nothing and says the next save overwrites', () => {
    mockRequest.mockResolvedValue(ok({}, '"rev-9"'));
    const onReload = jest.fn();
    render(<AdminConfigConflictNotice onReload={onReload} />);
    raise('platform');
    expect(screen.getByText(/your next save then replaces the newer version/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Keep my changes and overwrite on next save' })
    );

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
  });

  test('after "Keep my changes" the next save goes through with the current revision (R7)', async () => {
    // Loaded rev-1; someone else saved rev-2; the save with rev-1 is refused.
    mockRequest.mockResolvedValueOnce(ok({}, '"rev-1"'));
    await makeAdminApiCall('/admin/ui/config');
    mockRequest.mockRejectedValueOnce(conflict());
    await makeAdminApiCall('/admin/ui/config', { method: 'POST', body: { config: {} } }).catch(
      () => {}
    );
    render(<AdminConfigConflictNotice onReload={jest.fn()} />);
    raise('ui');

    mockRequest.mockResolvedValueOnce(ok({}, '"rev-2"'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep my changes and overwrite on next save' })
    );
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(3));
    expect(mockRequest.mock.calls[2][0]).toMatchObject({ url: '/admin/ui/config', method: 'GET' });

    mockRequest.mockResolvedValueOnce({ status: 204, data: '', headers: { etag: '"rev-3"' } });
    await makeAdminApiCall('/admin/ui/config', { method: 'POST', body: { config: {} } });
    expect(sentHeaders(3)['If-Match']).toBe('"rev-2"');
  });

  /** Load rev-1, have a save refused, and open the dialog. */
  const openStaleConflict = async () => {
    mockRequest.mockResolvedValueOnce(ok({}, '"rev-1"'));
    await makeAdminApiCall('/admin/ui/config');
    mockRequest.mockRejectedValueOnce(conflict());
    await makeAdminApiCall('/admin/ui/config', { method: 'POST', body: { config: {} } }).catch(
      () => {}
    );
    const onReload = jest.fn();
    render(<AdminConfigConflictNotice onReload={onReload} />);
    raise('ui');
    return onReload;
  };

  /** After a dismissal: nothing re-read, and the next save still sends the stale revision. */
  const expectNoOverwrite = async onReload => {
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledTimes(2);
    mockRequest.mockRejectedValueOnce(conflict());
    let saveError;
    await act(async () => {
      await makeAdminApiCall('/admin/ui/config', { method: 'POST', body: { config: {} } }).catch(
        error => {
          saveError = error;
        }
      );
    });
    expect(saveError).toMatchObject({ response: { status: 412 } });
    expect(sentHeaders(2)['If-Match']).toBe('"rev-1"');
    // The refusal brings the dialog back.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  };

  test('the initial focus is on Close, not on overwrite or reload', async () => {
    await openStaleConflict();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  test('Escape only closes: the next save still sends the old revision and gets 412', async () => {
    const onReload = await openStaleConflict();
    fireEvent.keyDown(window, { key: 'Escape' });
    await expectNoOverwrite(onReload);
  });

  test('a backdrop click only closes: the next save still gets 412', async () => {
    const onReload = await openStaleConflict();
    fireEvent.click(screen.getByTestId('config-conflict-backdrop'));
    await expectNoOverwrite(onReload);
  });

  test('Close (the focused button) only closes: the next save still gets 412', async () => {
    const onReload = await openStaleConflict();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await expectNoOverwrite(onReload);
  });

  test('"Reload" reloads', () => {
    const onReload = jest.fn();
    render(<AdminConfigConflictNotice onReload={onReload} />);
    raise('platform');

    fireEvent.click(screen.getByRole('button', { name: 'Reload and discard my changes' }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  test('end to end: a stale save keeps the form state and opens the dialog', async () => {
    mockRequest.mockResolvedValueOnce(ok({ setup: { disabled: false } }, '"rev-1"'));
    function Form() {
      return (
        <>
          <input aria-label="Title" defaultValue="" />
          <button
            type="button"
            onClick={() =>
              makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {} }).catch(
                () => {}
              )
            }
          >
            Save
          </button>
          <AdminConfigConflictNotice onReload={jest.fn()} />
        </>
      );
    }
    await makeAdminApiCall('/admin/configs/platform');
    mockRequest.mockRejectedValueOnce(conflict());
    render(<Form />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My edit' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('My edit');
  });
});

describe('scoped saves send only their own fields', () => {
  test('Advanced → onboarding toggle is a PATCH of setup.disabled only', async () => {
    mockRequest.mockImplementation(async config =>
      config.method === 'PATCH'
        ? ok({ setup: { disabled: true } }, '"rev-2"')
        : ok({ setup: { disabled: false }, auth: { jwtSecret: '***REDACTED***' } }, '"rev-1"')
    );
    render(<AdminAdvancedPage />);
    const toggle = await screen.findByRole('checkbox');
    await waitFor(() => expect(toggle).not.toBeDisabled());

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockRequest.mock.calls.some(([config]) => config.method === 'PATCH')).toBe(true)
    );
    const writes = mockRequest.mock.calls.filter(([config]) => config.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0][0].url).toBe('/admin/configs/platform');
    expect(writes[0][0].data).toEqual({ setup: { disabled: true } });
  });

  test("Security → Cookies is a PATCH, so another card's save on the page cannot make it 412 (R1)", async () => {
    mockRequest.mockImplementation(async config =>
      config.method === 'PATCH'
        ? ok({ cookieSettings: { disableSecure: true } }, '"rev-3"')
        : ok({ cookieSettings: { disableSecure: false } }, '"rev-1"')
    );
    render(<CookieSettingsConfig />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'admin.system.cookieSettings.saveConfig' }));

    await waitFor(() =>
      expect(mockRequest.mock.calls.some(([config]) => config.method === 'PATCH')).toBe(true)
    );
    const writes = mockRequest.mock.calls.filter(([config]) => config.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0][0].method).toBe('PATCH');
    expect(writes[0][0].data).toEqual({ cookieSettings: { disableSecure: true } });
    expect(writes[0][0].headers['If-Match']).toBeUndefined();
  });
});
