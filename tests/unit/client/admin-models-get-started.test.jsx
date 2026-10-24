// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Models with few models: a fresh install ships only disabled local
 * models, so the page leads with "Import from provider" and "Create new model"
 * in the middle of the screen until five models are configured.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  toggleModels: jest.fn(),
  getAdminApiErrorMessage: err => err?.message ?? 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/ModelDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ModelImportDialog', () => ({
  __esModule: true,
  default: () => <div data-testid="import-dialog" />
}));
jest.mock('../../../client/src/features/admin/hooks/useApiKeyStatus', () => ({
  __esModule: true,
  default: () => ({ statuses: {}, reload: () => {} })
}));
const mockFlags = { marketplace: true };
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: (name, fallback) => mockFlags[name] ?? fallback })
}));

const mockT = (key, defaultOrOptions) =>
  typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const AdminModelsPage = require('../../../client/src/features/admin/pages/AdminModelsPage').default;

const model = id => ({
  id,
  name: { en: id },
  description: { en: '' },
  provider: 'local',
  enabled: false
});

function Location() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(models) {
  mockMakeAdminApiCall.mockResolvedValue({ data: models });
  return render(
    <MemoryRouter initialEntries={['/admin/models']}>
      <Routes>
        <Route path="/admin/models" element={<AdminModelsPage />} />
        <Route path="*" element={<Location />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  mockFlags.marketplace = true;
});

test('a fresh install with three local models leads with the two ways to add models', async () => {
  renderPage([
    model('local-vllm'),
    model('voxtral-mini-realtime'),
    model('iassistant-conversation')
  ]);

  expect(await screen.findByText('Add the models your apps use')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Import from provider/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Create new model/ })).toBeInTheDocument();
});

test('Import from provider opens the import dialog', async () => {
  renderPage([model('local-vllm')]);

  fireEvent.click(await screen.findByRole('button', { name: /Import from provider/ }));
  expect(screen.getByTestId('import-dialog')).toBeInTheDocument();
});

test('Create new model opens the model editor', async () => {
  renderPage([]);

  fireEvent.click(await screen.findByRole('button', { name: /Create new model/ }));
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/models/new');
});

test('the marketplace link lists models, and is left out without the marketplace', async () => {
  const { unmount } = renderPage([]);
  fireEvent.click(await screen.findByRole('button', { name: 'the Marketplace' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/marketplace?type=model');
  unmount();

  mockFlags.marketplace = false;
  renderPage([]);
  await screen.findByText('Add the models your apps use');
  expect(screen.queryByRole('button', { name: 'the Marketplace' })).not.toBeInTheDocument();
});

test('five models hide the panel', async () => {
  renderPage(['a', 'b', 'c', 'd', 'e'].map(model));

  expect(await screen.findAllByText('a')).not.toHaveLength(0);
  expect(screen.queryByText('Add the models your apps use')).not.toBeInTheDocument();
});
