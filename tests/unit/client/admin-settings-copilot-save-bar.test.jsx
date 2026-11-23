// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Microsoft 365 Copilot settings page has ONE save, the bottom bar. The registration ID of
 * step 1 used to have a Save button of its own; it is saved with the agent of step 2 now. No
 * bar until something changed, Discard puts back every field (the ID included), Save sends the
 * whole page in one request, a failed save keeps the bar and names the error in it.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockApi(...args),
  getAdminApiErrorMessage: err => err?.message || ''
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path,
  buildApiUrl: path => `/api/${path}`,
  KNOWN_ROUTES: []
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const en = require('../../../shared/i18n/en.json');
const AdminCopilotAgentPage =
  require('../../../client/src/features/admin/pages/AdminCopilotAgentPage').default;

const STATUS = {
  enabled: true,
  oauthReferenceId: 'ref-1',
  name: 'iHub',
  description: 'Chat with iHub',
  instructions: 'Be brief',
  conversationStarters: [{ title: 'Summarize', text: 'Summarize this' }],
  defaultInstructions: 'Default instructions',
  limits: {},
  packageReady: true,
  prerequisites: { mcpGateway: true, publicHttps: true, appsExposed: true },
  registration: {
    baseUrl: 'https://ihub.example',
    authorizationEndpoint: 'https://ihub.example/authorize',
    tokenEndpoint: 'https://ihub.example/token',
    refreshEndpoint: 'https://ihub.example/token',
    scope: 'mcp',
    redirectUri: 'https://teams.example/redirect',
    clientId: 'client-1'
  }
};

let failSave;
const configCalls = () =>
  mockApi.mock.calls.filter(
    ([url, options]) => url === '/admin/copilot-agent/config' && options?.method === 'PUT'
  );

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const barButtons = () => within(bar()).getAllByRole('button');
const saveButton = () => barButtons().at(-1);
const discardButton = () => barButtons()[0];
const flush = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const renderPage = async () => {
  mockApi.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/copilot-agent/status') return { data: STATUS };
    if (url === '/admin/copilot-agent/config' && options.method === 'PUT') {
      if (failSave) throw new Error('boom');
      return { data: {} };
    }
    throw new Error(`unexpected admin call: ${url}`);
  });
  render(
    <MemoryRouter>
      <AdminCopilotAgentPage />
    </MemoryRouter>
  );
  await screen.findByLabelText('OAuth client registration ID');
  await flush();
};

beforeAll(() => {
  if (!global.crypto?.randomUUID) {
    global.crypto = { ...(global.crypto || {}), randomUUID: () => `id-${Math.random()}` };
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  failSave = false;
});

describe('Copilot agent settings page', () => {
  test('no bar for a page that was just loaded, and no Save button in the steps', async () => {
    await renderPage();
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  test('the registration ID of step 1 shows the bar; Discard puts it back', async () => {
    await renderPage();

    fireEvent.change(screen.getByLabelText('OAuth client registration ID'), {
      target: { value: 'ref-2' }
    });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByLabelText('OAuth client registration ID')).toHaveValue('ref-1');
    expect(bar()).not.toBeInTheDocument();
  });

  test('an edit of only a nested value (a conversation starter) counts as a change', async () => {
    await renderPage();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Summarise' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByLabelText('Title')).toHaveValue('Summarize');
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save sends the ID and the agent in one request, then the bar goes away', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('OAuth client registration ID'), {
      target: { value: 'ref-2' }
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'iHub Agent' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(configCalls()).toHaveLength(1);
    expect(configCalls()[0][1].body).toEqual({
      oauthReferenceId: 'ref-2',
      name: 'iHub Agent',
      description: 'Chat with iHub',
      instructions: 'Be brief',
      conversationStarters: [{ title: 'Summarize', text: 'Summarize this' }]
    });
    expect(bar()).not.toBeInTheDocument();
  });

  test('a change of only the registration ID is saved too, with the rest of the page', async () => {
    // The ID used to be saved alone by a button of step 1; the one save carries it now.
    await renderPage();
    fireEvent.change(screen.getByLabelText('OAuth client registration ID'), {
      target: { value: 'ref-2' }
    });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(configCalls()).toHaveLength(1);
    expect(configCalls()[0][1].body).toMatchObject({ oauthReferenceId: 'ref-2', name: 'iHub' });
  });

  test('a failed save keeps the bar and names the error in it', async () => {
    failSave = true;
    await renderPage();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'iHub Agent' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText(/Failed to save the settings: boom/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('iHub Agent');
    fireEvent.click(discardButton());
    expect(bar()).not.toBeInTheDocument();
  });
});
