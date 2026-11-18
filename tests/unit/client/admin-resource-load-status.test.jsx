// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
/**
 * The app and model editors hand the load error to the shared load-error panel
 * unchanged, so the panel sees its HTTP status: a 404 offers "Back to Apps" /
 * "Back to Models", a 403 says the account has no access and offers no Retry.
 * (Wrapping the axios error in `new Error(message)` dropped the status, so a
 * deleted app only offered Retry.)
 *
 * Runs the real pages, the real `useAdminResourceEditor` and the real panel;
 * only the API and heavy child editors are stubbed.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) {
        str = str.replace(new RegExp(`{{${k}}}`, 'g'), v);
      }
    }
    return str;
  };
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) };
});

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  fetchMarketplaceInstallations: jest.fn(() => Promise.resolve([])),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'failed'
}));

jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn(() => Promise.resolve([])),
  fetchUIConfig: jest.fn(() => Promise.resolve({})),
  fetchAppDetails: jest.fn(() => Promise.resolve({}))
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));

jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(() => Promise.resolve(null))
}));
jest.mock('../../../client/src/shared/components/DualModeEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => () => null);
jest.mock('../../../client/src/features/apps/pages/AppChat', () => () => null);

const AdminAppEditPage =
  require('../../../client/src/features/admin/pages/AdminAppEditPage').default;
const AdminModelEditPage =
  require('../../../client/src/features/admin/pages/AdminModelEditPage').default;

/** An axios-like error with a status and a problem+json body. */
function httpError(status, detail = 'Request failed') {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { detail, status }, headers: {} };
  return err;
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
        <Route path="/admin/apps" element={<h1>Apps list</h1>} />
        <Route path="/admin/models/:modelId" element={<AdminModelEditPage />} />
        <Route path="/admin/models" element={<h1>Models list</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

/** Every GET for the resource itself fails with `status`; the rest succeed empty. */
function failResourceLoad(resourcePath, status) {
  mockMakeAdminApiCall.mockImplementation(url =>
    url === resourcePath ? Promise.reject(httpError(status)) : Promise.resolve({ data: [] })
  );
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AdminAppEditPage load failure', () => {
  it('a 404 says the app was not found and offers "Back to Apps"', async () => {
    failResourceLoad('/admin/apps/gone', 404);
    renderAt('/admin/apps/gone');
    await flush();

    expect(screen.getByText('It may have been deleted or renamed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Apps' }));
    expect(screen.getByRole('heading', { name: 'Apps list' })).toBeInTheDocument();
  });

  it('a 403 says the account has no access and offers no Retry', async () => {
    failResourceLoad('/admin/apps/secret', 403);
    renderAt('/admin/apps/secret');
    await flush();

    expect(screen.getByText('Your account has no access to this page.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('AdminModelEditPage load failure', () => {
  it('a 404 says the model was not found and offers "Back to Models"', async () => {
    failResourceLoad('/admin/models/gone', 404);
    renderAt('/admin/models/gone');
    await flush();

    expect(screen.getByText('It may have been deleted or renamed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'admin.models.edit.backToModels' }));
    expect(screen.getByRole('heading', { name: 'Models list' })).toBeInTheDocument();
  });

  it('a 429 shows the rate-limit text, not the raw server message', async () => {
    failResourceLoad('/admin/models/busy', 429);
    renderAt('/admin/models/busy');
    await flush();

    expect(screen.getByText(/Too many requests right now\./)).toBeInTheDocument();
  });
});
