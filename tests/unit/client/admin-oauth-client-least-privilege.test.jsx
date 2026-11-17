// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → OAuth → client editor, least privilege (ID-B6).
 *
 * For a client-credentials (machine) client the allowed apps, models and
 * prompts ARE the grant: an empty list means nothing, and only an explicit
 * "All (*)" grants everything. So a new client starts with nothing selected,
 * needs at least one app before it can be saved, warns when "All (*)" is
 * chosen, and the editor warns when the grant types change on an existing
 * client, because that changes what the lists mean.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
const mockT = (key, defaultOrOptions) =>
  typeof defaultOrOptions === 'string'
    ? defaultOrOptions
    : (defaultOrOptions && defaultOrOptions.defaultValue) || key;
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

const {
  grantTypesChanged,
  isMachineClient,
  validateClientGrants
} = require('../../../client/src/features/admin/utils/oauthClientGrants');
const AdminOAuthClientEditPage =
  require('../../../client/src/features/admin/pages/AdminOAuthClientEditPage').default;

const APPS = [
  { id: 'chat', name: { en: 'Chat' } },
  { id: 'summarizer', name: { en: 'Summarizer' } }
];

/**
 * Renders the editor for `clientId` with the admin API answering like the
 * server: the client record and the created client are the response bodies.
 */
function renderEditor(clientId, storedClient = null) {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/apps') return { data: APPS };
    if (url === '/admin/models') return { data: { items: [] } };
    if (url === '/admin/prompts') return { data: [] };
    if (url === '/admin/oauth/clients' && options.method === 'POST') {
      return {
        data: { ...options.body, clientId: 'svc-new', clientSecret: 'shown-once-secret' }
      };
    }
    if (url === `/admin/oauth/clients/${clientId}` && !options.method) {
      return { data: storedClient };
    }
    return { data: {} };
  });
  render(
    <MemoryRouter initialEntries={[`/admin/oauth/clients/${clientId}`]}>
      <Routes>
        <Route path="/admin/oauth/clients/:clientId" element={<AdminOAuthClientEditPage />} />
        <Route path="/admin/oauth/clients" element={<div>clients list</div>} />
      </Routes>
    </MemoryRouter>
  );
}

/** The "All (*)" checkbox of the n-th resource list (0 apps, 1 models, 2 prompts). */
function allCheckbox(index) {
  return screen.getAllByText('All (*)')[index].previousSibling;
}

function postCalls() {
  return mockMakeAdminApiCall.mock.calls.filter(
    ([url, options]) => url === '/admin/oauth/clients' && options?.method === 'POST'
  );
}

describe('oauthClientGrants', () => {
  test('a client with client_credentials is a machine client', () => {
    expect(isMachineClient(['client_credentials'])).toBe(true);
    expect(isMachineClient(['authorization_code', 'client_credentials'])).toBe(true);
    expect(isMachineClient(['authorization_code'])).toBe(false);
    expect(isMachineClient(undefined)).toBe(false);
  });

  test('a machine client needs at least one app; "*" counts', () => {
    expect(validateClientGrants({ grantTypes: ['client_credentials'], allowedApps: [] })).toBe(
      'admin.auth.oauth.machineClientNeedsApp'
    );
    expect(validateClientGrants({ grantTypes: ['client_credentials'] })).toBe(
      'admin.auth.oauth.machineClientNeedsApp'
    );
    expect(
      validateClientGrants({ grantTypes: ['client_credentials'], allowedApps: ['*'] })
    ).toBeNull();
    expect(
      validateClientGrants({ grantTypes: ['authorization_code'], allowedApps: [] })
    ).toBeNull();
  });

  test('grant type changes ignore order', () => {
    expect(grantTypesChanged(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(grantTypesChanged(['client_credentials'], ['client_credentials', 'x'])).toBe(true);
    expect(grantTypesChanged(['a'], ['b'])).toBe(true);
  });
});

describe('new machine client', () => {
  test('starts with nothing selected and says the lists are the grant', async () => {
    renderEditor('new');

    expect(
      await screen.findByText('Nothing selected: this client can use no apps.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Nothing selected: this client can use no models.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Nothing selected: this client can use no prompts.')
    ).toBeInTheDocument();
    expect(screen.getByText(/these lists ARE the grant/)).toBeInTheDocument();
    for (const index of [0, 1, 2]) expect(allCheckbox(index)).not.toBeChecked();
    // The old hint described the lists as a filter on a user's permissions.
    expect(screen.queryByText(/By default, "All \(\*\)" is selected/)).not.toBeInTheDocument();
  });

  test('cannot be created without an app', async () => {
    renderEditor('new');
    fireEvent.change(await screen.findByLabelText(/Client Name/), {
      target: { value: 'Billing export' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(
      await screen.findByText(/A client-credentials client needs at least one app/)
    ).toBeInTheDocument();
    expect(postCalls()).toHaveLength(0);
  });

  test('"All (*)" warns, and the create request sends ["*"] for apps and [] for the rest', async () => {
    renderEditor('new');
    fireEvent.change(await screen.findByLabelText(/Client Name/), {
      target: { value: 'Billing export' }
    });

    expect(screen.queryByText(/All \(\*\) gives this client-credentials client/)).toBeNull();
    fireEvent.click(allCheckbox(0));
    expect(screen.getByText(/All \(\*\) gives this client-credentials client/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const body = postCalls()[0][1].body;
    expect(body.allowedApps).toEqual(['*']);
    expect(body.allowedModels).toEqual([]);
    expect(body.allowedPrompts).toEqual([]);

    // The created client (response body itself) is shown once.
    expect(await screen.findByText('svc-new')).toBeInTheDocument();
    expect(screen.getByText('shown-once-secret')).toBeInTheDocument();
  });
});

describe('existing client', () => {
  const STORED = {
    clientId: 'svc-1',
    name: 'Reporting',
    allowedApps: ['chat'],
    allowedModels: [],
    allowedPrompts: [],
    grantTypes: ['client_credentials']
  };

  test('loads the client record and warns when the grant types change', async () => {
    renderEditor('svc-1', STORED);

    expect(await screen.findByDisplayValue('Reporting')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.queryByText(/You changed the grant types/)).toBeNull();

    fireEvent.click(screen.getByText('Authorization Code (user login with PKCE)'));

    expect(await screen.findByText(/You changed the grant types/)).toBeInTheDocument();
    // With both grant types, both meanings of the lists are explained.
    expect(screen.getByText(/these lists ARE the grant/)).toBeInTheDocument();
    expect(screen.getByText(/the token acts as the signed-in user/)).toBeInTheDocument();
  });
});
