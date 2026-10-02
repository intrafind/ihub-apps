/**
 * Models from the marketplace ask the admin to review them before testing or
 * enabling them: the item's detail panel says so, a model card opens that
 * panel instead of installing straight away, and the model's edit page shows
 * the same notice while the model is installed from the marketplace.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  fetchMarketplaceItemDetail: jest.fn(),
  fetchMarketplaceInstallations: jest.fn(),
  installMarketplaceItem: jest.fn(),
  makeAdminApiCall: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: () => 'error',
  fetchMarketplaceItemDetail: (...args) => mockApi.fetchMarketplaceItemDetail(...args),
  fetchMarketplaceInstallations: (...args) => mockApi.fetchMarketplaceInstallations(...args),
  installMarketplaceItem: (...args) => mockApi.installMarketplaceItem(...args),
  updateMarketplaceItem: jest.fn(),
  uninstallMarketplaceItem: jest.fn(),
  detachMarketplaceItem: jest.fn(),
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args)
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));

// Heavy children that are not under test.
jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/DualModeEditor', () => ({
  __esModule: true,
  default: () => <div data-testid="model-editor" />
}));
jest.mock('../../../client/src/features/admin/components/ModelFormEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(async () => ({}))
}));
jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ blocker: { state: 'unblocked' }, markSaved: () => {} })
}));

const MarketplaceItemDetail =
  require('../../../client/src/features/admin/components/marketplace/MarketplaceItemDetail').default;
const MarketplaceItemCard =
  require('../../../client/src/features/admin/components/marketplace/MarketplaceItemCard').default;
const AdminModelEditPage =
  require('../../../client/src/features/admin/pages/AdminModelEditPage').default;

const REVIEW = /Review this model before you test or enable it/;
const item = type => ({
  registryId: 'official',
  type,
  name: `${type}-item`,
  displayName: { en: `A ${type}` },
  installationStatus: 'available'
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.fetchMarketplaceItemDetail.mockImplementation(async (registryId, type, name) => ({
    ...item(type),
    name
  }));
  mockApi.installMarketplaceItem.mockResolvedValue({});
});

describe('marketplace detail panel', () => {
  test('asks to review a model', async () => {
    render(
      <MemoryRouter>
        <MarketplaceItemDetail item={item('model')} onClose={() => {}} onAction={() => {}} />
      </MemoryRouter>
    );
    expect(await screen.findByText(REVIEW)).toBeInTheDocument();
    await waitFor(() => expect(mockApi.fetchMarketplaceItemDetail).toHaveBeenCalled());
  });

  test('says nothing of the kind for other item types', async () => {
    render(
      <MemoryRouter>
        <MarketplaceItemDetail item={item('app')} onClose={() => {}} onAction={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() => expect(mockApi.fetchMarketplaceItemDetail).toHaveBeenCalled());
    expect(screen.queryByText(REVIEW)).not.toBeInTheDocument();
  });
});

describe('marketplace card', () => {
  test('opens the detail panel for a model instead of installing it', () => {
    const onClick = jest.fn();
    render(<MarketplaceItemCard item={item('model')} onClick={onClick} onAction={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(onClick).toHaveBeenCalled();
    expect(mockApi.installMarketplaceItem).not.toHaveBeenCalled();
  });

  test('still installs other item types directly', async () => {
    const onClick = jest.fn();
    const onAction = jest.fn();
    render(<MarketplaceItemCard item={item('app')} onClick={onClick} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(mockApi.installMarketplaceItem).toHaveBeenCalledWith('official', 'app', 'app-item');
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('model edit page', () => {
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/admin/models/gpt-x']}>
        <Routes>
          <Route path="/admin/models/:modelId" element={<AdminModelEditPage />} />
        </Routes>
      </MemoryRouter>
    );

  beforeEach(() => {
    mockApi.makeAdminApiCall.mockImplementation(async path =>
      path === '/admin/models/gpt-x'
        ? { data: { id: 'gpt-x', name: { en: 'GPT X' }, provider: 'openai', enabled: false } }
        : { data: [] }
    );
  });

  test('asks to review a model installed from the marketplace', async () => {
    mockApi.fetchMarketplaceInstallations.mockResolvedValue({
      'model:gpt-x': { type: 'model', itemId: 'gpt-x', registryId: 'official' }
    });
    renderPage();
    expect(await screen.findByText(REVIEW)).toBeInTheDocument();
  });

  test('shows no notice for other models, or when the marketplace is unavailable', async () => {
    mockApi.fetchMarketplaceInstallations.mockResolvedValue({ 'model:other': { type: 'model' } });
    const { unmount } = renderPage();
    await screen.findByTestId('model-editor');
    await waitFor(() => expect(mockApi.fetchMarketplaceInstallations).toHaveBeenCalled());
    expect(screen.queryByText(REVIEW)).not.toBeInTheDocument();
    unmount();

    mockApi.fetchMarketplaceInstallations.mockRejectedValue(new Error('feature disabled'));
    renderPage();
    await screen.findByTestId('model-editor');
    expect(screen.queryByText(REVIEW)).not.toBeInTheDocument();
  });
});
