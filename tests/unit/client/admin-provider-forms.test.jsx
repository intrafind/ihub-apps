// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Provider create and edit forms (AI-B18, AI-B20, AI-B3):
 *
 * - every field has a linked label, the API key included;
 * - no "Provider Enabled" checkbox: the server reads every provider entry,
 *   enabled or not, so the edit page showed it permanently disabled;
 * - the create page no longer offers web search providers or generic API
 *   keys (they moved to Integrations);
 * - the fields use the shared admin field style.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminProviderCreatePage from '../../../client/src/features/admin/pages/AdminProviderCreatePage';
import AdminProviderEditPage from '../../../client/src/features/admin/pages/AdminProviderEditPage';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';
import { INPUT_CLASS } from '../../../client/src/features/admin/components/formStyles';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));

jest.mock('../../../client/src/features/admin/hooks/useAdminPageAccess', () => ({
  __esModule: true,
  default: () => ({ models: true })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

jest.mock('../../../client/src/features/admin/components/GatewaySyncDialog', () => ({
  __esModule: true,
  default: () => null
}));

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/providers/new" element={<AdminProviderCreatePage />} />
        <Route path="/admin/providers/:providerId" element={<AdminProviderEditPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  makeAdminApiCall.mockReset();
});

describe('AdminProviderCreatePage', () => {
  it('labels every field, the API key included, in the shared field style', () => {
    renderAt('/admin/providers/new');
    for (const name of [/^Name/, /^ID/, 'Description', 'API type', 'Base URL', /^API Key/]) {
      const field = screen.getByLabelText(name);
      expect(field).toHaveClass(...INPUT_CLASS.split(' ').slice(0, 4));
    }
  });

  it('has no "Provider Enabled" checkbox', () => {
    renderAt('/admin/providers/new');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Provider Enabled')).not.toBeInTheDocument();
  });

  it('describes an LLM endpoint, not web search providers or generic API keys', () => {
    renderAt('/admin/providers/new');
    expect(screen.getByText(/Connect an AI endpoint of your own/)).toBeInTheDocument();
    expect(screen.queryByText(/web search provider/)).not.toBeInTheDocument();
  });
});

describe('AdminProviderEditPage', () => {
  beforeEach(() => {
    makeAdminApiCall.mockImplementation(async path => {
      if (path === '/admin/providers/llmhub') {
        return {
          data: {
            id: 'llmhub',
            name: 'LLM Hub',
            description: '',
            category: 'llm',
            apiType: 'openai',
            enabled: true,
            apiKeySet: true,
            apiKeyMasked: '••••••••'
          }
        };
      }
      if (path === '/admin/models') return { data: { items: [] } };
      if (path === '/admin/llm-timeouts') return { data: { effective: {} } };
      return { data: {} };
    });
  });

  it('links the API key label and its "configured" note to the field', async () => {
    renderAt('/admin/providers/llmhub');
    const apiKey = await screen.findByLabelText(/^API Key/);
    expect(apiKey).toHaveAttribute('type', 'password');
    expect(apiKey).toHaveAccessibleDescription('An API key is currently configured');
  });

  it('has no permanently disabled "Provider Enabled" checkbox', async () => {
    renderAt('/admin/providers/llmhub');
    await screen.findByLabelText(/^API Key/);
    expect(screen.queryByText('Provider Enabled')).not.toBeInTheDocument();
  });
});
