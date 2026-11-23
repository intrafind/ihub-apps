// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The AWS region on the AWS Bedrock provider page: shown only for the Bedrock
 * provider, prefilled from `config.region`, flagged when it is not a region,
 * and saved as `config.region` (an empty field removes it, so the server's
 * AWS_REGION applies again).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminProviderEditPage from '../../../client/src/features/admin/pages/AdminProviderEditPage';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';

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

const PROVIDERS = {
  bedrock: {
    id: 'bedrock',
    name: 'AWS Bedrock',
    description: '',
    category: 'llm',
    enabled: true,
    apiKeySet: true,
    apiKeyMasked: '••••••••',
    config: { region: 'eu-west-1' }
  },
  openai: { id: 'openai', name: 'OpenAI', description: '', enabled: true, apiKeySet: false }
};

function renderAt(id) {
  return render(
    <MemoryRouter initialEntries={[`/admin/providers/${id}`]}>
      <Routes>
        <Route path="/admin/providers/:providerId" element={<AdminProviderEditPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  makeAdminApiCall.mockReset();
  makeAdminApiCall.mockImplementation(async (path, options = {}) => {
    if (options.method === 'PUT') return { data: {} };
    const id = path.replace('/admin/providers/', '');
    if (PROVIDERS[id]) return { data: PROVIDERS[id] };
    if (path === '/admin/models') return { data: { items: [] } };
    if (path === '/admin/llm-timeouts') return { data: { effective: {} } };
    return { data: {} };
  });
});

const lastPut = () =>
  makeAdminApiCall.mock.calls.filter(([, options]) => options?.method === 'PUT').at(-1)?.[1].body;

const save = async () => {
  await act(async () => {
    fireEvent.submit(screen.getByLabelText('AWS region').closest('form'));
  });
};

test('shows the stored region of the Bedrock provider and saves a new one', async () => {
  renderAt('bedrock');
  const region = await screen.findByLabelText('AWS region');
  expect(region).toHaveValue('eu-west-1');
  expect(region).toHaveAttribute('placeholder', 'eu-central-1');

  fireEvent.change(region, { target: { value: 'us-east-1' } });
  expect(region).toHaveAttribute('aria-invalid', 'false');
  await save();
  expect(lastPut()).toMatchObject({ id: 'bedrock', config: { region: 'us-east-1' } });
});

test('flags a value that is not a region', async () => {
  renderAt('bedrock');
  const region = await screen.findByLabelText('AWS region');
  fireEvent.change(region, { target: { value: 'Frankfurt' } });
  expect(region).toHaveAttribute('aria-invalid', 'true');
  expect(region).toHaveAccessibleDescription(
    expect.stringContaining('Enter an AWS region code such as eu-central-1, or global.')
  );
});

test('an empty region removes it from the provider', async () => {
  renderAt('bedrock');
  const region = await screen.findByLabelText('AWS region');
  fireEvent.change(region, { target: { value: '' } });
  await save();
  // `undefined` is left out of the JSON body.
  expect(lastPut().config).toBeUndefined();
});

test('other providers have no region field', async () => {
  renderAt('openai');
  await screen.findByLabelText(/^API Key/);
  expect(screen.queryByLabelText('AWS region')).not.toBeInTheDocument();
});
