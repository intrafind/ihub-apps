// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import AdminAuthPage from '../../../client/src/features/admin/pages/AdminAuthPage';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';
import { getSchemaByType } from '../../../client/src/utils/schemaService';

/**
 * Admin → Authentication after a failed load (ID-B1): the page used to keep
 * built-in defaults (Proxy mode, local sign-in off), say "All valid" and offer
 * Save, so one click could lock the admin out. Now it shows the load error with
 * Retry and no form. The group list and the schema are optional. Also the
 * unsaved-changes guard (ID-B11).
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

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  listCredentials: jest.fn().mockResolvedValue([]),
  getAdminApiErrorMessage: err =>
    err?.response?.data?.detail || err?.message || 'An unexpected error occurred'
}));

jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  importBuilderActions: jest.fn()
}));

jest.mock('../../../client/src/utils/schemaService', () => ({
  getSchemaByType: jest.fn()
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {}, refreshConfig: jest.fn() })
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path
}));

jest.mock('../../../client/src/shared/components/MonacoJsonEditor', () => ({
  __esModule: true,
  default: () => <div data-testid="json-editor" />
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span />
}));

const PLATFORM = {
  auth: { mode: 'local', authenticatedGroup: 'authenticated' },
  anonymousAuth: { enabled: false, defaultGroups: ['anonymous'] },
  localAuth: { enabled: true, sessionTimeoutMinutes: 480 },
  proxyAuth: { enabled: false },
  oidcAuth: { enabled: false, providers: [] }
};

/** An axios-like error with a status and a problem+json body. */
function httpError(status, detail = 'Request failed') {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { detail, status }, headers: {} };
  return err;
}

/**
 * Answer the page's GETs from a table; anything not in it rejects. Writes are
 * recorded and succeed.
 */
function routeApi({ platform, groups, schema }) {
  makeAdminApiCall.mockImplementation((url, options = {}) => {
    const method = options.method || 'GET';
    if (method !== 'GET') return Promise.resolve({ data: {} });
    if (url === '/admin/configs/platform') return platform();
    if (url === '/admin/groups') return groups();
    return Promise.reject(httpError(404));
  });
  getSchemaByType.mockImplementation(() => schema());
}

const ok = data => () => Promise.resolve({ data });
const fail = status => () => Promise.reject(httpError(status));

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const writes = () => makeAdminApiCall.mock.calls.filter(([, options]) => options?.method);

function LeaveButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/admin/users')}>
      Go to users
    </button>
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/auth']}>
      <LeaveButton />
      <Routes>
        <Route path="/admin/auth" element={<AdminAuthPage />} />
        <Route path="/admin/users" element={<h1>Users page</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AdminAuthPage after a failed load', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the load error with Retry, and no form, no Save and no "All valid"', async () => {
    routeApi({
      platform: fail(429),
      groups: ok({ groups: {} }),
      schema: () => Promise.resolve({})
    });
    renderPage();
    await flush();

    // Page chrome stays, so the admin knows where they are.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Authentication Configuration' })
    ).toBeInTheDocument();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load authentication settings");
    expect(alert).toHaveTextContent('Nothing was changed.');
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.queryByText('All valid')).not.toBeInTheDocument();
    expect(screen.queryByText(/Proxy Mode/i)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it('Retry loads again in place and then shows the stored values', async () => {
    let platformCalls = 0;
    routeApi({
      platform: () => {
        platformCalls += 1;
        return platformCalls === 1
          ? Promise.reject(httpError(500, 'Server down'))
          : Promise.resolve({ data: PLATFORM });
      },
      groups: ok({ groups: {} }),
      schema: () => Promise.resolve({})
    });
    renderPage();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Server down Nothing was changed.');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await flush();

    expect(platformCalls).toBe(2);
    expect(screen.queryByText("Couldn't load authentication settings")).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Configuration' })).toBeEnabled();
    expect(writes()).toHaveLength(0);
  });

  it('does not gate on the optional group list and schema', async () => {
    routeApi({
      platform: ok(PLATFORM),
      groups: fail(500),
      schema: () => Promise.reject(new Error('no schema'))
    });
    renderPage();
    await flush();

    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Configuration' })).toBeEnabled();
  });

  it('saves exactly what was loaded (no built-in defaults merged in)', async () => {
    routeApi({
      platform: ok(PLATFORM),
      groups: ok({ groups: {} }),
      schema: () => Promise.resolve({})
    });
    renderPage();
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
    });
    await flush();

    expect(writes()).toHaveLength(1);
    const [url, options] = writes()[0];
    expect(url).toBe('/admin/configs/platform');
    expect(options.body).toEqual(PLATFORM);
  });
});

describe('AdminAuthPage unsaved-changes guard (ID-B11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    routeApi({
      platform: ok(PLATFORM),
      groups: ok({ groups: {} }),
      schema: () => Promise.resolve({})
    });
  });

  it('is not dirty right after the load: leaving does not ask', async () => {
    renderPage();
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Go to users' }));
    expect(screen.getByRole('heading', { name: 'Users page' })).toBeInTheDocument();
  });

  it('asks before leaving with unsaved edits, and Stay keeps the page', async () => {
    renderPage();
    await flush();

    const timeout = screen.getByDisplayValue('480');
    fireEvent.change(timeout, { target: { value: '60' } });

    fireEvent.click(screen.getByRole('button', { name: 'Go to users' }));
    expect(screen.queryByRole('heading', { name: 'Users page' })).not.toBeInTheDocument();
    expect(screen.getByText('You have unsaved changes. Leave anyway?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByDisplayValue('60')).toBeInTheDocument();
  });
});
