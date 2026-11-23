// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A deleted model or app can be restored from its page (AI-B12): the delete
 * dialog says "open {{path}} again to restore it", and the page of the deleted
 * item then offers "Restore from History" in place of "Back to …" when the
 * change history holds a copy. After the rollback the page loads the item.
 *
 * Also pins the Test button of the model editor (review recommendation 9).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

jest.mock('react-i18next', () => {
  const translate = (key, fallbackOrOptions, maybeOptions) => {
    const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions || {};
    const text = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : options.defaultValue;
    if (typeof text !== 'string') return key;
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
  };
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) };
});

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  fetchAdminModels: jest.fn(() => Promise.resolve([])),
  fetchMarketplaceInstallations: jest.fn(() => Promise.resolve([])),
  assignedDefaultModelId: () => null,
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'failed'
}));
jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn(() => Promise.resolve([])),
  fetchUIConfig: jest.fn(() => Promise.resolve({})),
  fetchAppDetails: jest.fn(() => Promise.resolve({}))
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(() => Promise.resolve(null))
}));
jest.mock('../../../client/src/api/usageReportsAdminApi', () => ({
  fetchUsageBreakdown: jest.fn(() => Promise.resolve({ rows: [] }))
}));
jest.mock('../../../client/src/shared/components/DualModeEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => () => null);
jest.mock('../../../client/src/features/apps/pages/AppChat', () => () => null);
// The drawer as a stand-in: open or closed, and a button that completes a rollback.
jest.mock(
  '../../../client/src/features/admin/components/ChangeHistoryDrawer',
  () => props =>
    props.isOpen ? (
      <div data-testid="history-drawer">
        {props.resource}/{props.resourceId}
        {props.onRestored && (
          <button type="button" onClick={props.onRestored}>
            rolled back
          </button>
        )}
      </div>
    ) : null
);

const AdminModelEditPage =
  require('../../../client/src/features/admin/pages/AdminModelEditPage').default;
const AdminAppEditPage =
  require('../../../client/src/features/admin/pages/AdminAppEditPage').default;

function httpError(status, detail = 'Request failed') {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { detail, status }, headers: {} };
  return err;
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/models/:modelId" element={<AdminModelEditPage />} />
        <Route path="/admin/models" element={<h1>Models list</h1>} />
        <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
        <Route path="/admin/apps" element={<h1>Apps list</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

const STORED_MODEL = {
  id: 'gone',
  name: { en: 'Gone model' },
  description: { en: 'd' },
  provider: 'openai',
  enabled: true
};

/**
 * The item answers 404 until `state.restored`; its change history holds `snapshots`.
 */
function serve({ itemPath, item, snapshots, state = {}, testAnswer }) {
  mockMakeAdminApiCall.mockImplementation((url, options = {}) => {
    if (url === itemPath) {
      return state.restored ? Promise.resolve({ data: item }) : Promise.reject(httpError(404));
    }
    if (url.startsWith('/admin/changes/')) return Promise.resolve({ data: snapshots });
    if (url.endsWith('/_test') && options.method === 'POST') return testAnswer();
    return Promise.resolve({ data: [] });
  });
  return state;
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the page of a deleted model', () => {
  test('offers "Restore from History" when the history has a copy, and loads it after the rollback', async () => {
    const state = serve({
      itemPath: '/admin/models/gone',
      item: STORED_MODEL,
      snapshots: [{ ts: '2026-11-20T10:00:00Z', filename: 'a.json' }]
    });
    renderAt('/admin/models/gone');
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Restore from History' }));
    expect(screen.getByTestId('history-drawer')).toHaveTextContent('model/gone');

    state.restored = true;
    fireEvent.click(screen.getByRole('button', { name: 'rolled back' }));
    await flush();

    expect(screen.queryByTestId('history-drawer')).not.toBeInTheDocument();
    expect(screen.queryByText('It may have been deleted or renamed.')).not.toBeInTheDocument();
  });

  test('keeps "Back to Models" when the history holds nothing', async () => {
    serve({ itemPath: '/admin/models/gone', item: STORED_MODEL, snapshots: [] });
    renderAt('/admin/models/gone');
    await flush();

    expect(screen.queryByRole('button', { name: 'Restore from History' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'admin.models.edit.backToModels' })).toBeVisible();
  });
});

test('the page of a deleted app offers "Restore from History" too', async () => {
  serve({
    itemPath: '/admin/apps/gone',
    item: { id: 'gone' },
    snapshots: [{ ts: '2026-11-20T10:00:00Z', filename: 'a.json' }]
  });
  renderAt('/admin/apps/gone');
  await flush();

  fireEvent.click(screen.getByRole('button', { name: 'Restore from History' }));
  expect(screen.getByTestId('history-drawer')).toHaveTextContent('app/gone');
});

describe('the Test button of the model editor', () => {
  test('tests the stored model and shows the answer', async () => {
    serve({
      itemPath: '/admin/models/gone',
      item: STORED_MODEL,
      snapshots: [],
      state: { restored: true },
      testAnswer: () => Promise.resolve({ data: { response: 'Hi there' } })
    });
    renderAt('/admin/models/gone');
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });
    await flush();

    expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/models/gone/_test', {
      method: 'POST'
    });
    expect(screen.getByTestId('model-test-result')).toHaveTextContent('Hi there');
  });

  test('shows a failed test with its remedy', async () => {
    const failure = httpError(502, 'Provider refused the key');
    failure.response.data.details = { remediation: 'Enter the key again' };
    serve({
      itemPath: '/admin/models/gone',
      item: STORED_MODEL,
      snapshots: [],
      state: { restored: true },
      testAnswer: () => Promise.reject(failure)
    });
    renderAt('/admin/models/gone');
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    });
    await flush();

    const result = screen.getByTestId('model-test-result');
    expect(result).toHaveTextContent('Provider refused the key');
    expect(result).toHaveTextContent('Enter the key again');
  });

  test('is not offered on a new model', async () => {
    serve({ itemPath: '/admin/models/new', item: null, snapshots: [] });
    renderAt('/admin/models/new');
    await flush();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
  });
});
