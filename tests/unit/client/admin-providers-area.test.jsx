// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Models → Providers tab: only model providers are the page. Each row
 * links to its models (the Models tab, filtered), says when it sets its own
 * timeouts and offers to import models; entries of other categories stay
 * reachable in a collapsed group instead of vanishing.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.message ?? 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useApiKeyStatus', () => ({
  __esModule: true,
  default: () => ({ statuses: {}, reload: () => {} })
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true })
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

const AdminProvidersPage =
  require('../../../client/src/features/admin/pages/AdminProvidersPage').default;

const providers = [
  { id: 'openai', name: 'OpenAI', description: 'OpenAI API', enabled: true },
  {
    id: 'google',
    name: 'Google',
    description: 'Gemini',
    enabled: true,
    streamIdleTimeoutMs: 180000
  },
  {
    id: 'llmhub',
    name: 'T-Systems LLM Hub',
    description: 'Gateway',
    category: 'llm',
    apiType: 'openai',
    enabled: true
  },
  // `enabled: false` changes nothing on the server (it reads every provider): no badge for it.
  { id: 'bedrock', name: 'AWS Bedrock', description: '', category: 'llm', enabled: false },
  { id: 'old-key', name: 'Old generic key', description: '', category: 'custom', enabled: true }
];
const models = [
  { id: 'gpt', name: { en: 'GPT' }, provider: 'openai', enabled: true },
  { id: 'gemini', name: { en: 'Gemini' }, provider: 'google', enabled: true },
  { id: 'hub-a', name: { en: 'Hub A' }, provider: 'openai', providerId: 'llmhub', enabled: false }
];

function Location() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {`${location.pathname}${location.search}`}
      <span data-testid="state">{JSON.stringify(location.state)}</span>
    </div>
  );
}

function renderPage() {
  mockMakeAdminApiCall.mockImplementation(async path => {
    if (path === '/admin/providers') return { data: { items: providers } };
    if (path === '/admin/models') return { data: { items: models } };
    if (path === '/admin/llm-timeouts') {
      return {
        data: {
          saved: {},
          defaults: { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000 },
          effective: { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000 }
        }
      };
    }
    return { data: {} };
  });
  return render(
    <MemoryRouter initialEntries={['/admin/providers']}>
      <Routes>
        <Route path="/admin/providers" element={<AdminProvidersPage />} />
        <Route path="*" element={<Location />} />
      </Routes>
    </MemoryRouter>
  );
}

const rowOf = async name => (await screen.findByText(name)).closest('tr');

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  mockPlatform.admin.pages = {};
});

test('shares the tab bar with Models and starts on Providers', async () => {
  renderPage();
  await screen.findByRole('tab', { name: 'Providers 5' });
  expect(screen.getByRole('tab', { name: 'Providers 5' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: 'Models 3' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/models');
});

test('a provider row links to its models on the Models tab', async () => {
  renderPage();
  const row = await rowOf('Google');
  const link = within(row).getByRole('link', { name: /1 linked, 1 enabled/ });
  expect(link).toHaveAttribute('href', '/admin/models?provider=google');
  const hub = within(await rowOf('T-Systems LLM Hub')).getByRole('link', {
    name: /1 linked, 0 enabled/
  });
  expect(hub).toHaveAttribute('href', '/admin/models?provider=llmhub');
});

test('marks only the provider that sets its own timeouts', async () => {
  renderPage();
  expect(within(await rowOf('Google')).getByText('Sets its own timeouts')).toBeInTheDocument();
  expect(
    within(await rowOf('OpenAI')).queryByText('Sets its own timeouts')
  ).not.toBeInTheDocument();
});

test('a provider stored with enabled: false gets no "Disabled" badge, since the flag has no effect', async () => {
  renderPage();
  const row = await rowOf('AWS Bedrock');
  expect(within(row).queryByText('Disabled')).not.toBeInTheDocument();
  expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
});

test('Import opens the models page with the provider preselected, where the API type allows it', async () => {
  renderPage();
  fireEvent.click(
    within(await rowOf('T-Systems LLM Hub')).getByRole('button', { name: 'Import models' })
  );
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/models');
  expect(screen.getByTestId('state')).toHaveTextContent('"importProviderId":"llmhub"');
});

test('Add provider opens the connect flow', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/providers/connect');
});

test('entries of other categories wait in one collapsed group instead of leading the page', async () => {
  renderPage();
  const summary = await screen.findByText('Other credentials (1)');
  const group = summary.closest('details');
  expect(group).not.toHaveAttribute('open');
  expect(within(group).getByText('Old generic key')).toBeInTheDocument();
  // The model providers are not inside it.
  expect(within(group).queryByText('Google')).not.toBeInTheDocument();
});

test('the timeouts for all providers are one summary line above the list', async () => {
  renderPage();
  expect(await screen.findByTestId('llm-timeouts-summary')).toHaveTextContent(
    'connect 30 s · stream idle 60 s'
  );
});

test('every row keeps Configure in the pinned actions column, and the search has a name', async () => {
  renderPage();
  const row = await rowOf('OpenAI');
  const configure = within(row).getByRole('button', { name: 'Configure' });
  // The shared DataTable pins its actions cell to the right edge, so at phone
  // width the table scrolls under it instead of hiding it.
  expect(configure.closest('td')).toHaveClass('sticky', 'right-0');
  fireEvent.click(configure);
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/providers/openai');
});

test('the provider search has an accessible name, not only a placeholder', async () => {
  renderPage();
  expect(await screen.findByRole('searchbox', { name: 'Search providers' })).toBeInTheDocument();
});

test('without the models page there is no link to it: the count is plain text, Import is gone, no Models tab', async () => {
  mockPlatform.admin.pages = { models: false };
  renderPage();
  const row = await rowOf('Google');
  expect(within(row).queryByRole('link')).not.toBeInTheDocument();
  expect(within(row).getByText(/1 linked, 1 enabled/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Import models' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: /Models/ })).not.toBeInTheDocument();
});

test('asks before leaving the Providers page with an unsaved timeout, and not when nothing changed', async () => {
  renderPage();
  await screen.findByRole('tab', { name: 'Providers 5' });

  // Nothing changed: the Models tab opens at once.
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  expect(screen.queryByRole('region', { name: 'Save changes' })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Connect timeout (ms)'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Models 3' }));

  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(screen.queryByTestId('location')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(screen.getByLabelText('Connect timeout (ms)')).toHaveValue(5);
});

test('lets the admin leave the Providers page when no timeout changed', async () => {
  renderPage();
  await screen.findByRole('tab', { name: 'Providers 5' });

  fireEvent.click(screen.getByRole('tab', { name: 'Models 3' }));

  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/models');
});
