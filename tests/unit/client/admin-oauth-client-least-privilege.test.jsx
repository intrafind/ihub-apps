// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → OAuth → client editor, least privilege (ID-B6).
 *
 * For a client-credentials (machine) client the allowed apps, models and
 * prompts ARE the grant: an empty list means nothing, and only an explicit
 * "All (*)" grants everything. So a new client starts with nothing selected,
 * needs at least one app, model or prompt before it can be saved, warns when "All (*)" is
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
  clientGrantWarnings,
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

function putCalls() {
  return mockMakeAdminApiCall.mock.calls.filter(([, options]) => options?.method === 'PUT');
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

  test('a machine client needs at least one app, model or prompt; "*" counts', () => {
    expect(validateClientGrants({ grantTypes: ['client_credentials'], allowedApps: [] })).toBe(
      'admin.auth.oauth.machineClientNeedsGrant'
    );
    expect(validateClientGrants({ grantTypes: ['client_credentials'] })).toBe(
      'admin.auth.oauth.machineClientNeedsGrant'
    );
    // A client of the OpenAI-compatible API needs only models.
    expect(
      validateClientGrants({ grantTypes: ['client_credentials'], allowedModels: ['gpt-x'] })
    ).toBeNull();
    expect(
      clientGrantWarnings({ grantTypes: ['client_credentials'], allowedModels: ['gpt-x'] })
    ).toEqual([]);
    expect(
      validateClientGrants({ grantTypes: ['client_credentials'], allowedPrompts: ['p1'] })
    ).toBeNull();
    expect(
      validateClientGrants({ grantTypes: ['client_credentials'], allowedApps: ['*'] })
    ).toBeNull();
    expect(
      validateClientGrants({ grantTypes: ['authorization_code'], allowedApps: [] })
    ).toBeNull();
  });

  test('a personal API key is never a machine client', () => {
    expect(isMachineClient(['client_credentials'], { personal: true })).toBe(false);
    expect(
      validateClientGrants(
        { grantTypes: ['client_credentials'], allowedApps: [] },
        { isNew: false, initialLists: { allowedApps: ['chat'] }, personal: true }
      )
    ).toBeNull();
    expect(
      clientGrantWarnings(
        { grantTypes: ['client_credentials'], allowedApps: [] },
        { personal: true }
      )
    ).toEqual([]);
  });

  test('an inactive machine client may be saved without apps', () => {
    expect(
      validateClientGrants({ grantTypes: ['client_credentials'], allowedApps: [], active: false })
    ).toBeNull();
  });

  test('an existing machine client blocks only when its lists are all emptied', () => {
    const empty = { grantTypes: ['client_credentials'], allowedApps: [] };
    expect(validateClientGrants(empty, { isNew: false, initialLists: {} })).toBeNull();
    expect(
      validateClientGrants(empty, { isNew: false, initialLists: { allowedApps: ['chat'] } })
    ).toBe('admin.auth.oauth.machineClientNeedsGrant');
    expect(
      validateClientGrants(empty, { isNew: false, initialLists: { allowedModels: ['gpt-x'] } })
    ).toBe('admin.auth.oauth.machineClientNeedsGrant');
  });

  test('a machine client with apps but no models is warned, not blocked', () => {
    const form = { grantTypes: ['client_credentials'], allowedApps: ['chat'], allowedModels: [] };
    expect(validateClientGrants(form)).toBeNull();
    expect(clientGrantWarnings(form)).toEqual(['admin.auth.oauth.machineClientHasNoModels']);
    expect(clientGrantWarnings({ ...form, allowedModels: ['*'] })).toEqual([]);
    expect(
      clientGrantWarnings({ grantTypes: ['authorization_code'], allowedApps: ['chat'] })
    ).toEqual([]);
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
      await screen.findByText(/A client-credentials client needs at least one app, model or prompt/)
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
    expect(screen.getByDisplayValue('shown-once-secret')).toBeInTheDocument();
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

  test('an existing machine client whose apps were already empty can be renamed', async () => {
    renderEditor('svc-2', { ...STORED, clientId: 'svc-2', allowedApps: [] });

    const name = await screen.findByDisplayValue('Reporting');
    expect(
      screen.getByText(/has no apps, models or prompts, so its tokens can do nothing/)
    ).toBeInTheDocument();
    fireEvent.change(name, { target: { value: 'Reporting (parked)' } });
    fireEvent.click(screen.getByRole('button', { name: /Update|Save/ }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0][1].body.name).toBe('Reporting (parked)');
    expect(screen.queryByText(/needs at least one app, model or prompt/)).toBeNull();
  });

  test('an existing machine client cannot have all its lists emptied while active', async () => {
    renderEditor('svc-1', STORED);
    await screen.findByDisplayValue('Reporting');

    // The chip's remove button (an icon only) sits inside the chip.
    fireEvent.click(screen.getByText('Chat').querySelector('button'));
    fireEvent.click(screen.getByRole('button', { name: /Update|Save/ }));

    expect(await screen.findByText(/needs at least one app, model or prompt/)).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
  });

  test('warns when a machine client has apps but no models', async () => {
    renderEditor('svc-1', STORED);
    expect(await screen.findByText(/This client has apps but no models/)).toBeInTheDocument();
  });

  test('a personal API key is edited as a delegated client', async () => {
    renderEditor('pk-1', {
      ...STORED,
      clientId: 'pk-1',
      name: 'My key',
      personal: true,
      allowedApps: []
    });

    expect(await screen.findByDisplayValue('My key')).toBeInTheDocument();
    expect(screen.getByText(/Personal API key: the token acts as the user/)).toBeInTheDocument();
    expect(screen.queryByText(/these lists ARE the grant/)).toBeNull();
    expect(screen.queryByText('Nothing selected: this client can use no apps.')).toBeNull();
    expect(
      screen.queryByText(/has no apps, models or prompts, so its tokens can do nothing/)
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Update|Save/ }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
  });

  test('"All (*)" on a delegated client is not presented as harmless', async () => {
    renderEditor('web-1', {
      ...STORED,
      clientId: 'web-1',
      grantTypes: ['authorization_code', 'refresh_token'],
      allowedApps: ['*']
    });

    expect(await screen.findByText(/All \(\*\) sets no client-level limit/)).toBeInTheDocument();
    expect(screen.queryByText(/"All \(\*\)" adds no restriction/)).toBeNull();
  });
});
