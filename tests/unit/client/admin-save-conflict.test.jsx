// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Optimistic locking of platform and UI config saves on the client (decision 6).
 *
 * A form passes its own revision holder to `makeAdminApiCall` for the read that
 * fills it and for its save of `/admin/configs/platform` or `/admin/ui/config`.
 * The holder takes the `ETag` of that read and of each successful save, and the
 * save sends it as `If-Match`; a read by another page or card in the same tab
 * never changes it. On `412 PRECONDITION_FAILED` one conflict dialog opens. The
 * dialog keeps the admin's edits (nothing on the page is touched), offers
 * Reload, re-reads only the refused form's revision on "Keep my changes", and
 * never retries.
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
jest.mock('../../../client/src/shared/components/DualModeEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/PlatformFormEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/LoadingSpinner', () => ({
  __esModule: true,
  default: () => <span>Loading</span>
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  getSchemaByType: async () => ({})
}));

const { makeAdminApiCall } = require('../../../client/src/api/adminApi');
const {
  CONFIG_CONFLICT_EVENT,
  createConfigRevision
} = require('../../../client/src/api/adminConfigRevision');
const AdminConfigConflictNotice =
  require('../../../client/src/features/admin/components/AdminConfigConflictNotice').default;
const AdminAdvancedPage =
  require('../../../client/src/features/admin/pages/AdminAdvancedPage').default;
const CookieSettingsConfig =
  require('../../../client/src/features/admin/components/CookieSettingsConfig').default;
const AdminAuthPage = require('../../../client/src/features/admin/pages/AdminAuthPage').default;

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
  localStorage.clear();
});

describe('makeAdminApiCall: If-Match for platform and UI config saves', () => {
  test("a POST of the platform config sends the ETag of the form's own read", async () => {
    mockRequest.mockResolvedValueOnce(ok({}, '"rev-1"')).mockResolvedValueOnce(ok({}, '"rev-2"'));
    const revision = createConfigRevision();

    await makeAdminApiCall('/admin/configs/platform', { revision });
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: { a: 1 }, revision });

    expect(sentHeaders(0)['If-Match']).toBeUndefined();
    expect(sentHeaders(1)['If-Match']).toBe('"rev-1"');
  });

  test('the ETag of a successful save is used for the next save (no re-read needed)', async () => {
    mockRequest
      .mockResolvedValueOnce(ok({}, '"rev-1"'))
      .mockResolvedValueOnce(ok({}, '"rev-2"'))
      .mockResolvedValueOnce(ok({}, '"rev-3"'));

    const revision = createConfigRevision();
    await makeAdminApiCall('/admin/configs/platform', { revision });
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {}, revision });
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {}, revision });

    expect(sentHeaders(2)['If-Match']).toBe('"rev-2"');
  });

  test("another read of the same file in the tab does not change the form's If-Match", async () => {
    // The form loaded rev-1. Another admin saved; another page's read then
    // finished with rev-2. The form never saw that change: its save must send
    // rev-1 and be refused, not carry rev-2 and overwrite the change.
    mockRequest
      .mockResolvedValueOnce(ok({}, '"rev-1"'))
      .mockResolvedValueOnce(ok({}, '"rev-2"'))
      .mockResolvedValueOnce(ok({}, '"rev-2"'))
      .mockRejectedValueOnce(conflict());
    const form = createConfigRevision();

    await makeAdminApiCall('/admin/configs/platform', { revision: form });
    await makeAdminApiCall('/admin/configs/platform', { revision: createConfigRevision() });
    await makeAdminApiCall('/admin/configs/platform');
    await expect(
      makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {}, revision: form })
    ).rejects.toMatchObject({ response: { status: 412 } });

    expect(sentHeaders(3)['If-Match']).toBe('"rev-1"');
    expect(form.current).toBe('"rev-1"');
  });

  test('UI config and platform config keep separate revisions', async () => {
    mockRequest
      .mockResolvedValueOnce(ok({}, '"ui-1"'))
      .mockResolvedValueOnce(ok({}, '"platform-1"'))
      .mockResolvedValueOnce({ status: 204, data: '', headers: { etag: '"ui-2"' } });

    const uiForm = createConfigRevision();
    const platformForm = createConfigRevision();
    await makeAdminApiCall('/admin/ui/config', { revision: uiForm });
    await makeAdminApiCall('/admin/configs/platform', { revision: platformForm });
    await makeAdminApiCall('/admin/ui/config', {
      method: 'POST',
      body: { config: {} },
      revision: uiForm
    });

    expect(sentHeaders(2)['If-Match']).toBe('"ui-1"');
    expect(uiForm.current).toBe('"ui-2"');
    expect(platformForm.current).toBe('"platform-1"');
  });

  test('scoped PATCH and other endpoints are not guarded', async () => {
    mockRequest.mockResolvedValue(ok({}, '"rev-1"'));
    const revision = createConfigRevision();

    await makeAdminApiCall('/admin/configs/platform', { revision });
    await makeAdminApiCall('/admin/configs/platform', {
      method: 'PATCH',
      body: { setup: {} },
      revision
    });
    await makeAdminApiCall('/admin/apps/x', { method: 'POST', body: {}, revision });

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

    const form = createConfigRevision();
    await makeAdminApiCall('/admin/configs/platform', { revision: form });
    await makeAdminApiCall('/admin/configs/platform', {
      method: 'PATCH',
      body: { cookieSettings: { disableSecure: true } },
      revision: form
    });
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {}, revision: form });

    expect(sentHeaders(2)['If-Match']).toBe('"rev-1"');
  });

  test('no read yet, or no revision holder: no If-Match (the save behaves as before)', async () => {
    mockRequest.mockResolvedValue(ok({}, '"rev-1"'));
    await makeAdminApiCall('/admin/configs/platform', {
      method: 'POST',
      body: {},
      revision: createConfigRevision()
    });
    await makeAdminApiCall('/admin/configs/platform');
    await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {} });
    expect(sentHeaders(0)['If-Match']).toBeUndefined();
    expect(sentHeaders(2)['If-Match']).toBeUndefined();
  });

  test('a 412 raises the conflict event once, is rethrown, and is not retried', async () => {
    const events = [];
    const listener = event => events.push(event.detail);
    window.addEventListener(CONFIG_CONFLICT_EVENT, listener);
    mockRequest.mockResolvedValueOnce(ok({}, '"rev-1"')).mockRejectedValueOnce(conflict());
    const revision = createConfigRevision();

    await makeAdminApiCall('/admin/configs/platform', { revision });
    await expect(
      makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: {}, revision })
    ).rejects.toMatchObject({ response: { status: 412 } });

    window.removeEventListener(CONFIG_CONFLICT_EVENT, listener);
    expect(events).toEqual([{ resource: 'platform', revision }]);
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
    const form = createConfigRevision();
    const otherForm = createConfigRevision();
    otherForm.current = '"other-1"';
    render(<AdminConfigConflictNotice onReload={jest.fn()} />);
    mockRequest.mockResolvedValueOnce(ok({}, '"rev-1"'));
    await makeAdminApiCall('/admin/ui/config', { revision: form });
    mockRequest.mockRejectedValueOnce(conflict());
    await act(async () => {
      await makeAdminApiCall('/admin/ui/config', {
        method: 'POST',
        body: { config: {} },
        revision: form
      }).catch(() => {});
    });

    mockRequest.mockResolvedValueOnce(ok({}, '"rev-2"'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep my changes and overwrite on next save' })
    );
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(3));
    expect(mockRequest.mock.calls[2][0]).toMatchObject({ url: '/admin/ui/config', method: 'GET' });
    await waitFor(() => expect(form.current).toBe('"rev-2"'));
    // Only the refused form's revision was re-read.
    expect(otherForm.current).toBe('"other-1"');

    mockRequest.mockResolvedValueOnce({ status: 204, data: '', headers: { etag: '"rev-3"' } });
    await makeAdminApiCall('/admin/ui/config', {
      method: 'POST',
      body: { config: {} },
      revision: form
    });
    expect(sentHeaders(3)['If-Match']).toBe('"rev-2"');
  });

  /** The form whose save the dialog was opened for. */
  let staleForm;

  /** Load rev-1, have a save refused, and open the dialog. */
  const openStaleConflict = async () => {
    staleForm = createConfigRevision();
    const onReload = jest.fn();
    render(<AdminConfigConflictNotice onReload={onReload} />);
    mockRequest.mockResolvedValueOnce(ok({}, '"rev-1"'));
    await makeAdminApiCall('/admin/ui/config', { revision: staleForm });
    mockRequest.mockRejectedValueOnce(conflict());
    await act(async () => {
      await makeAdminApiCall('/admin/ui/config', {
        method: 'POST',
        body: { config: {} },
        revision: staleForm
      }).catch(() => {});
    });
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
      await makeAdminApiCall('/admin/ui/config', {
        method: 'POST',
        body: { config: {} },
        revision: staleForm
      }).catch(error => {
        saveError = error;
      });
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
    const revision = createConfigRevision();
    function Form() {
      return (
        <>
          <input aria-label="Title" defaultValue="" />
          <button
            type="button"
            onClick={() =>
              makeAdminApiCall('/admin/configs/platform', {
                method: 'POST',
                body: {},
                revision
              }).catch(() => {})
            }
          >
            Save
          </button>
          <AdminConfigConflictNotice onReload={jest.fn()} />
        </>
      );
    }
    await makeAdminApiCall('/admin/configs/platform', { revision });
    mockRequest.mockRejectedValueOnce(conflict());
    render(<Form />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My edit' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('My edit');
  });
});

describe('a full-config form saves against the revision it loaded', () => {
  test('Authentication: a later read elsewhere in the tab does not let its save overwrite (412)', async () => {
    // 1. The Authentication page loads rev-1.
    // 2. Another admin saves; another page's read of the platform config then
    //    finishes with rev-2, which includes that change.
    // 3. Authentication saves its rev-1-based form: it must send rev-1 and be
    //    refused, not send rev-2 and overwrite the other admin's change.
    let platformReads = 0;
    mockRequest.mockImplementation(async config => {
      if (config.url === '/admin/groups') return ok({ groups: {} });
      if (config.method === 'GET') {
        platformReads += 1;
        return ok({ auth: { mode: 'local' } }, platformReads === 1 ? '"rev-1"' : '"rev-2"');
      }
      throw conflict();
    });
    render(
      <>
        <AdminAuthPage />
        <AdminConfigConflictNotice onReload={jest.fn()} />
      </>
    );
    const save = await screen.findByRole('button', { name: 'Save Configuration' });
    expect(platformReads).toBe(1);

    await act(async () => {
      await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
    });
    expect(platformReads).toBe(2);

    fireEvent.click(save);

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    const posts = mockRequest.mock.calls.filter(([config]) => config.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0].headers['If-Match']).toBe('"rev-1"');
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
