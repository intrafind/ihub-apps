// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Models: models and the providers that serve them are one area with two
 * tabs. This pins what the Models tab adds to the old flat list: the setup strip
 * (derived from what is configured), the provider column and filter, the tab bar,
 * and the overflow menu for the rare actions.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
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
  default: ({ initialProviderId }) => (
    <div data-testid="import-dialog">{initialProviderId || 'any'}</div>
  )
}));
const mockKeyStatuses = { models: {}, providers: {} };
jest.mock('../../../client/src/features/admin/hooks/useApiKeyStatus', () => ({
  __esModule: true,
  default: kind => ({ statuses: mockKeyStatuses[kind] || {}, reload: () => {} })
}));
const mockFlags = { marketplace: true };
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: (name, fallback) => mockFlags[name] ?? fallback })
}));
const mockPlatform = { admin: { pages: {} } };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatform })
}));

const mockT = (key, defaultOrOptions, options) => {
  if (typeof defaultOrOptions !== 'string') return key;
  return defaultOrOptions.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const AdminModelsPage = require('../../../client/src/features/admin/pages/AdminModelsPage').default;

const model = (id, extra = {}) => ({
  id,
  name: { en: id },
  description: { en: '' },
  provider: 'local',
  enabled: false,
  ...extra
});

const providers = [
  { id: 'openai', name: 'OpenAI', enabled: true },
  { id: 'google', name: 'Google', enabled: true, streamIdleTimeoutMs: 180000 },
  { id: 'llmhub', name: 'T-Systems LLM Hub', category: 'llm', apiType: 'openai', enabled: true }
];

function Location() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage({ models = [], providerList = providers, url = '/admin/models' } = {}) {
  mockMakeAdminApiCall.mockImplementation(async path => {
    if (path === '/admin/models') return { data: models };
    if (path === '/admin/providers') return { data: providerList };
    return { data: {} };
  });
  return render(
    <MemoryRouter initialEntries={[url]}>
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
  mockKeyStatuses.models = {};
  mockKeyStatuses.providers = {};
  mockPlatform.admin.pages = {};
});

describe('tab bar', () => {
  test('shows Models and Providers with their counts, Models active', async () => {
    renderPage({ models: [model('a'), model('b')] });
    await screen.findByRole('tab', { name: 'Models 2' });
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Models2',
      'Providers3'
    ]);
    expect(screen.getByRole('tab', { name: /Models/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('Providers opens the providers route', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Providers/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/providers');
  });

  test('an admin without the providers page sees no tab bar', async () => {
    mockPlatform.admin.pages = { providers: false };
    renderPage({ models: [model('a')] });
    expect(await screen.findByRole('heading', { name: 'Models' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

describe('setup strip', () => {
  test('a fresh install starts with connecting a provider', async () => {
    renderPage({ models: [model('local-vllm'), model('voxtral')] });
    const strip = await screen.findByTestId('models-setup');
    expect(within(strip).getAllByRole('listitem')).toHaveLength(3);
    expect(within(strip).getByText('Connect a provider').closest('li')).toHaveAttribute(
      'aria-current',
      'step'
    );

    fireEvent.click(within(strip).getByRole('button', { name: 'Add a provider key' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/providers');
  });

  test('with a usable key, the next step is importing models', async () => {
    mockKeyStatuses.providers = { openai: { state: 'ok' } };
    renderPage({ models: [model('local-vllm')] });
    const strip = await screen.findByTestId('models-setup');
    expect(within(strip).getByText('Connect a provider').closest('li')).toHaveTextContent('(done)');

    fireEvent.click(within(strip).getByRole('button', { name: 'Import models' }));
    expect(screen.getByTestId('import-dialog')).toBeInTheDocument();
  });

  test('the shipped keyless local provider does not make a fresh install look connected', async () => {
    mockKeyStatuses.providers = { local: { state: 'keyless' } };
    renderPage({ models: [model('local-vllm')] });
    const strip = await screen.findByTestId('models-setup');
    expect(within(strip).getByText('Connect a provider').closest('li')).toHaveTextContent(
      '(to do)'
    );
  });

  test('an enabled model on a keyless endpoint counts as connected; the default is next', async () => {
    mockKeyStatuses.providers = { local: { state: 'keyless' } };
    renderPage({ models: [model('local-vllm', { enabled: true })] });
    const strip = await screen.findByTestId('models-setup');
    expect(within(strip).getByText('Connect a provider').closest('li')).toHaveTextContent('(done)');
    expect(within(strip).getByText('Enable models').closest('li')).toHaveTextContent('(done)');
    expect(within(strip).getByRole('button', { name: 'Show enabled models' })).toBeInTheDocument();
  });

  test('disappears once a provider is connected, a model is enabled and one is the default', async () => {
    mockKeyStatuses.providers = { openai: { state: 'ok' } };
    renderPage({ models: [model('gpt', { provider: 'openai', enabled: true, default: true })] });
    await screen.findAllByText('gpt');
    expect(screen.queryByTestId('models-setup')).not.toBeInTheDocument();
  });
});

describe('provider column and filter', () => {
  const models = [
    model('gpt', { provider: 'openai', enabled: true }),
    model('gemini', { provider: 'google', enabled: true }),
    model('hub-a', { provider: 'openai', providerId: 'llmhub' }),
    model('iassistant', { provider: 'iassistant-conversation' })
  ];

  test('names the provider and links to it; a model without an entry shows its API type', async () => {
    renderPage({ models });
    const link = await screen.findByRole('link', { name: 'T-Systems LLM Hub' });
    expect(link).toHaveAttribute('href', '/admin/providers/llmhub');
    expect(screen.getByRole('link', { name: 'OpenAI' })).toHaveAttribute(
      'href',
      '/admin/providers/openai'
    );
    // Next to the filter option of the same name, the cell shows the API type.
    expect(
      screen.getAllByText('iassistant-conversation').some(element => element.tagName === 'SPAN')
    ).toBe(true);
  });

  test('marks a provider that sets its own timeouts', async () => {
    renderPage({ models });
    await screen.findByRole('link', { name: 'Google' });
    expect(screen.getAllByText('This provider sets its own timeouts')).not.toHaveLength(0);
  });

  test('?provider= narrows the list, and the select offers only providers in use', async () => {
    renderPage({ models, url: '/admin/models?provider=llmhub' });
    await screen.findByRole('link', { name: 'T-Systems LLM Hub' });
    expect(screen.queryByText('gemini')).not.toBeInTheDocument();
    expect(screen.queryByText('gpt')).not.toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Provider' });
    expect(select).toHaveValue('llmhub');
    expect([...select.options].map(option => option.textContent)).toEqual([
      'All providers',
      'Google',
      'iassistant-conversation',
      'OpenAI',
      'T-Systems LLM Hub'
    ]);
  });

  test('the type filter keeps chat models apart from speech models', async () => {
    renderPage({
      models: [
        model('chat-model', { provider: 'openai', name: { en: 'Chat Model' } }),
        model('stt-model', {
          provider: 'openai',
          modelType: 'transcription',
          name: { en: 'Speech Model' }
        })
      ]
    });
    await screen.findByText('Chat Model');
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), {
      target: { value: 'transcription' }
    });
    expect(screen.queryByText('Chat Model')).not.toBeInTheDocument();
    expect(screen.getByText('Speech Model')).toBeInTheDocument();
  });
});

describe('actions', () => {
  test('Add New Model opens the model editor', async () => {
    renderPage({ models: [model('a')] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add New Model' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/models/new');
  });

  test('Import models opens the import dialog without a preset provider', async () => {
    renderPage({ models: [model('a')] });
    fireEvent.click(await screen.findByRole('button', { name: 'Import models' }));
    expect(screen.getByTestId('import-dialog')).toHaveTextContent('any');
  });

  test('the rare actions live in the overflow menu, which Escape closes', async () => {
    renderPage({ models: [model('a')] });
    const button = await screen.findByRole('button', { name: 'More model actions' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(button);
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map(item => item.textContent)).toEqual([
      'Upload Config',
      'Install from Marketplace',
      'Enable All',
      'Disable All'
    ]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  test('the Marketplace entry opens the model catalog, and is left out without the marketplace', async () => {
    const { unmount } = renderPage({ models: [model('a')] });
    fireEvent.click(await screen.findByRole('button', { name: 'More model actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Install from Marketplace' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/marketplace?type=model');
    unmount();

    mockFlags.marketplace = false;
    renderPage({ models: [model('a')] });
    fireEvent.click(await screen.findByRole('button', { name: 'More model actions' }));
    expect(
      screen.queryByRole('menuitem', { name: 'Install from Marketplace' })
    ).not.toBeInTheDocument();
  });
});
