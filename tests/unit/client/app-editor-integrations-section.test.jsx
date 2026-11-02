// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * App editor → Integrations: each integration in one place. Web search keeps
 * its own panel for every chat app (native search needs no engine), whose
 * engine select lists Auto and the installed engines; iAssistant keeps its
 * panel while installed or in use, its switch being the `iassistant` binding;
 * the people directories and the storage providers get a card each whose
 * switch binds every installation of the type (`type:people-directory`,
 * `type:storage`); and the generic list never repeats a web search engine,
 * iAssistant or a storage provider.
 */

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, options) => {
    let text = typeof defaultValue === 'string' ? defaultValue : key;
    for (const [name, value] of Object.entries(options || {})) {
      text = text.replace(`{{${name}}}`, String(value));
    }
    return text;
  };
  const i18n = { language: 'en' };
  return { useTranslation: () => ({ t: translate, i18n }) };
});

const mockFetchInstalled = jest.fn();
const mockFetchOne = jest.fn();
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...args) => mockFetchInstalled(...args),
  fetchInstalledIntegration: (...args) => mockFetchOne(...args)
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'failed'
}));

import IntegrationsConfigSection, {
  mergeInstallationDetails
} from '../../../client/src/features/admin/components/app-form/IntegrationsConfigSection';
import {
  webSearchEngineStatus,
  webSearchEnginesOf
} from '../../../client/src/features/admin/components/app-form/webSearchEngines';

const INSTALLED = [
  {
    id: 'qwant',
    definition: 'com.intrafind/qwant-search',
    type: 'web-search',
    builtIn: true,
    label: 'Qwant'
  },
  {
    id: 'brave',
    definition: 'com.intrafind/brave-search',
    type: 'web-search',
    builtIn: true,
    label: 'Brave Search',
    enabled: false
  },
  { id: 'iassistant', definition: 'com.intrafind/iassistant', builtIn: true, label: 'iAssistant' },
  { id: 'ifinder', definition: 'com.intrafind/ifinder', builtIn: true, label: 'iFinder' },
  { id: 'office365', definition: 'com.intrafind/office365', type: 'storage', builtIn: true },
  {
    id: 'corp',
    definition: 'com.intrafind/ldap-directory',
    type: 'people-directory',
    builtIn: true,
    label: 'Corporate directory'
  },
  {
    id: 'entra',
    definition: 'com.intrafind/entra-directory',
    type: 'people-directory',
    builtIn: true,
    label: 'Entra ID'
  },
  { id: 'drawio', definition: 'mcp/drawio', protocol: 'mcp', builtIn: true, label: 'draw.io' },
  { id: 'open-data-portal', definition: 'org.ckan/open-data-portal', label: 'GovData' }
];

function renderSection(app, onChange = jest.fn()) {
  render(
    <MemoryRouter>
      <IntegrationsConfigSection app={app} onChange={onChange} />
    </MemoryRouter>
  );
  return onChange;
}

beforeEach(() => {
  mockFetchInstalled.mockReset();
  mockFetchOne.mockReset();
  mockFetchOne.mockResolvedValue({ actions: [], definition: null });
});

describe('IntegrationsConfigSection', () => {
  it('shows web search and iAssistant as panels and never as generic rows', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    renderSection({ id: 'a' });
    expect(await screen.findByText('Web Search')).toBeInTheDocument();
    expect(screen.getByText('Enable iAssistant')).toBeInTheDocument();

    const generic = screen.getByTestId('app-integrations');
    expect(within(generic).queryByText('Qwant')).not.toBeInTheDocument();
    expect(within(generic).queryByText('Brave Search')).not.toBeInTheDocument();
    expect(within(generic).queryByText('iassistant')).not.toBeInTheDocument();
    expect(within(generic).queryByText('office365')).not.toBeInTheDocument();
    // The rest is grouped.
    expect(within(generic).getByText('MCP servers')).toBeInTheDocument();
    expect(within(generic).getByText('Built-in')).toBeInTheDocument();
    expect(within(generic).getByText('From the catalog')).toBeInTheDocument();
    expect(within(generic).getByText('GovData')).toBeInTheDocument();
  });

  it('shows the web search panel without any engine, and hides an unused iAssistant', async () => {
    mockFetchInstalled.mockResolvedValue({
      items: INSTALLED.filter(i => i.type !== 'web-search' && i.id !== 'iassistant')
    });
    renderSection({ id: 'a', websearch: { enabled: true } });
    await screen.findByTestId('app-integrations-people-directories');
    expect(screen.getByText('Web Search')).toBeInTheDocument();
    expect(screen.queryByText('Enable iAssistant')).not.toBeInTheDocument();
    // No "not installed" notice: native search needs no engine.
    expect(screen.queryByText(/Web Search is not installed/)).not.toBeInTheDocument();
    expect(screen.getByTestId('websearch-no-engine')).toHaveTextContent(
      'the app searches only on models with native search'
    );
    expect(screen.getByRole('link', { name: 'Install an engine' })).toHaveAttribute(
      'href',
      '/admin/integrations?tab=catalog'
    );
  });

  it('lists Auto and the enabled engines in Auto’s order, leaving disabled ones out', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    const onChange = renderSection({ id: 'a', websearch: { enabled: true } });
    const select = await screen.findByLabelText('Search engine');
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Auto', 'Qwant (qwant)']);
    expect(select).toHaveValue('auto');
    expect(screen.queryByTestId('websearch-no-engine')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'qwant' } });
    expect(onChange.mock.calls.at(-1)[0].websearch).toEqual({ enabled: true, provider: 'qwant' });
  });

  it('warns about an engine the app names that is not installed, or is disabled', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    renderSection({ id: 'a', websearch: { enabled: true, provider: 'staan' } });
    const select = await screen.findByLabelText('Search engine');
    expect(select).toHaveValue('staan');
    expect(within(select).getByRole('option', { name: 'staan — not installed' })).toBeTruthy();
    expect(screen.getByTestId('websearch-engine-missing')).toHaveTextContent(
      'The engine "staan" is not installed'
    );
  });

  it('keeps the engine the app names selected when the engine list fails to load', async () => {
    mockFetchInstalled.mockRejectedValue(new Error('offline'));
    renderSection({ id: 'a', websearch: { enabled: true, provider: 'brave' } });
    const select = await screen.findByLabelText('Search engine');
    // Not "Auto": the stored engine stays shown, without a not-installed claim.
    await waitFor(() => expect(within(select).getByRole('option', { name: 'brave' })).toBeTruthy());
    expect(select).toHaveValue('brave');
    expect(screen.queryByTestId('websearch-engine-missing')).not.toBeInTheDocument();
  });

  it('keeps and warns about a disabled engine the app names', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    renderSection({ id: 'a', websearch: { enabled: true, provider: 'brave' } });
    const select = await screen.findByLabelText('Search engine');
    expect(
      within(select).getByRole('option', { name: 'Brave Search (brave) — disabled' })
    ).toBeInTheDocument();
    expect(await screen.findByTestId('websearch-engine-disabled')).toHaveTextContent(
      'The engine "brave" is disabled'
    );
    expect(screen.queryByTestId('websearch-engine-missing')).not.toBeInTheDocument();
  });

  it('keeps the iAssistant panel the app already uses, with a notice that it is not installed', async () => {
    mockFetchInstalled.mockResolvedValue({ items: [] });
    renderSection({ id: 'a', iassistant: { enabled: true } });
    expect(await screen.findByText('Enable iAssistant')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('iAssistant is not installed');
  });

  it('binds every people directory with the type key from the card switch', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    const onChange = renderSection({ id: 'a' });
    const card = await screen.findByTestId('app-integrations-people-directories');
    // Off: no choice and no rows yet.
    expect(within(card).queryByText('Corporate directory')).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('switch', { name: 'Enable people directories' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)[0].integrations).toEqual({ 'type:people-directory': {} });
  });

  it('shows the type binding once, with its Required setting, and the directories below', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    const onChange = renderSection({
      id: 'a',
      integrations: { 'type:people-directory': {} }
    });
    const card = await screen.findByTestId('app-integrations-people-directories');
    expect(within(card).getByRole('switch', { name: 'Enable people directories' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(within(card).getByLabelText('All people directories')).toBeChecked();
    expect(within(card).getAllByText('All people directories')).toHaveLength(1);
    expect(within(card).getByText('Corporate directory')).toBeInTheDocument();
    expect(within(card).getByText('Entra ID')).toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText(/Required/));
    expect(onChange.mock.calls.at(-1)[0].integrations).toEqual({
      'type:people-directory': { required: false }
    });
  });

  it('switches to selected directories and back, and off removes every directory binding', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    const app = {
      id: 'a',
      integrations: { 'type:people-directory': {}, corp: { actions: [] }, drawio: {} }
    };
    const onChange = renderSection(app);
    const card = await screen.findByTestId('app-integrations-people-directories');
    fireEvent.click(within(card).getByLabelText('Only selected directories'));
    expect(onChange.mock.calls.at(-1)[0].integrations).toEqual({
      corp: { actions: [] },
      drawio: {}
    });
    fireEvent.click(within(card).getByRole('switch', { name: 'Enable people directories' }));
    expect(onChange.mock.calls.at(-1)[0].integrations).toEqual({ drawio: {} });
  });

  it('keeps the switch on for an app that binds single directories only', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    renderSection({ id: 'a', integrations: { entra: {} } });
    const card = await screen.findByTestId('app-integrations-people-directories');
    expect(within(card).getByRole('switch', { name: 'Enable people directories' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(within(card).getByLabelText('Only selected directories')).toBeChecked();
    expect(within(card).getByLabelText(/Entra ID/)).toBeChecked();
  });

  it('lists LDAP browsers among the built-ins, never in the people directories card', async () => {
    const browsers = [
      {
        id: 'corp-browser',
        definition: 'com.intrafind/ldap-browser',
        definitionName: 'LDAP browser',
        builtIn: true,
        label: 'Company directory – LDAP browser'
      },
      {
        id: 'infra-browser',
        definition: 'com.intrafind/ldap-browser',
        definitionName: 'LDAP browser',
        builtIn: true,
        label: 'Infra – LDAP browser'
      }
    ];
    mockFetchInstalled.mockResolvedValue({ items: [...INSTALLED, ...browsers] });
    mockFetchOne.mockResolvedValue({
      actions: [
        { name: 'browse_search', title: 'Search entries', available: true },
        { name: 'browse_read', title: 'Read an entry', available: true },
        { name: 'browse_children', title: 'List children', available: true }
      ],
      definition: { id: 'com.intrafind/ldap-browser' }
    });
    const onChange = renderSection({ id: 'a' });
    const card = await screen.findByTestId('app-integrations-people-directories');
    expect(within(card).queryByText(/LDAP browser/)).not.toBeInTheDocument();

    const generic = screen.getByTestId('app-integrations');
    const builtIn = within(generic).getByText('Built-in').closest('section');
    expect(within(builtIn).getByText('Company directory – LDAP browser')).toBeInTheDocument();
    // Two installations: "All LDAP browser installations" binds the definition.
    fireEvent.click(within(builtIn).getByLabelText(/All LDAP browser installations/));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // A browser binding without actions binds all three browse actions.
    expect(onChange.mock.calls.at(-1)[0].integrations).toEqual({
      'com.intrafind/ldap-browser': {}
    });
  });

  it('binds the iAssistant installation with the Enable iAssistant switch', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    const onChange = renderSection({ id: 'a' });
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable iAssistant' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const app = onChange.mock.calls.at(-1)[0];
    expect(app.integrations).toEqual({ iassistant: {} });
    expect(app.iassistant).toEqual({ enabled: true });
    expect(screen.queryByText(/Use in this app/)).not.toBeInTheDocument();
  });

  it('shows the iAssistant binding settings inside the panel, and off unbinds', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    mockFetchOne.mockResolvedValue({
      actions: [],
      definition: { id: 'com.intrafind/iassistant', scopes: { label: 'iAssistant' } }
    });
    const onChange = renderSection({
      id: 'a',
      iassistant: { enabled: true },
      integrations: { iassistant: { required: false } }
    });
    expect(await screen.findByLabelText('Default iAssistant')).toBeInTheDocument();
    expect(screen.getByLabelText(/Required/)).not.toBeChecked();
    // No empty action list for an integration without actions.
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable iAssistant' }));
    const app = onChange.mock.calls.at(-1)[0];
    expect(app.integrations).toBeUndefined();
    expect(app.iassistant).toEqual({ enabled: false });
  });

  it('does not list a definition or type binding of an installed integration as not installed', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    renderSection({
      id: 'a',
      integrations: {
        'com.intrafind/office365': {},
        'type:storage': {},
        'com.intrafind/qwant-search': {},
        'type:web-search': {},
        'gone-integration': {}
      }
    });
    expect(await screen.findByTestId('stale-integration-gone-integration')).toBeInTheDocument();
    for (const key of [
      'com.intrafind/office365',
      'type:storage',
      'com.intrafind/qwant-search',
      'type:web-search'
    ]) {
      expect(screen.queryByTestId(`stale-integration-${key}`)).not.toBeInTheDocument();
    }
  });

  it('offers a definition row the actions of all its installations', async () => {
    mockFetchInstalled.mockResolvedValue({
      items: [
        { id: 'gh-a', definition: 'mcp/github', protocol: 'mcp', builtIn: true, label: 'A' },
        { id: 'gh-b', definition: 'mcp/github', protocol: 'mcp', builtIn: true, label: 'B' }
      ]
    });
    mockFetchOne.mockImplementation(id =>
      Promise.resolve({
        definition: { id: 'mcp/github' },
        actions:
          id === 'gh-a'
            ? [{ name: 'list_issues', title: 'List issues', available: true }]
            : [{ name: 'create_pr', title: 'Create PR', available: true }]
      })
    );
    renderSection({ id: 'a', integrations: { 'mcp/github': {} } });
    const row = await screen.findByTestId('definition-binding-mcp/github');
    expect(await within(row).findByText('List issues')).toBeInTheDocument();
    expect(within(row).getByText('Create PR')).toBeInTheDocument();
  });
});

describe('IntegrationsConfigSection: disabled installations', () => {
  const DISABLED = [
    { id: 'iassistant', definition: 'com.intrafind/iassistant', builtIn: true, enabled: false },
    {
      id: 'corp',
      definition: 'com.intrafind/ldap-directory',
      definitionName: 'People directory (LDAP)',
      type: 'people-directory',
      builtIn: true,
      label: 'Corporate directory',
      enabled: false
    },
    {
      id: 'muc',
      definition: 'com.intrafind/ldap-directory',
      definitionName: 'People directory (LDAP)',
      type: 'people-directory',
      builtIn: true,
      label: 'Munich directory'
    },
    {
      id: 'entra',
      definition: 'com.intrafind/entra-directory',
      type: 'people-directory',
      builtIn: true,
      label: 'Entra ID'
    },
    { id: 'drawio', definition: 'mcp/drawio', protocol: 'mcp', label: 'draw.io', enabled: false },
    { id: 'open-data-portal', definition: 'org.ckan/open-data-portal', label: 'GovData' }
  ];

  it('offers no disabled installation the app does not bind, and says how many are left out', async () => {
    mockFetchInstalled.mockResolvedValue({ items: DISABLED });
    renderSection({ id: 'a', integrations: { 'type:people-directory': {} } });
    const card = await screen.findByTestId('app-integrations-people-directories');
    expect(within(card).queryByText('Corporate directory')).not.toBeInTheDocument();
    expect(within(card).getByText('Munich directory')).toBeInTheDocument();
    // One enabled LDAP directory left: no "All … installations" row, and the count is the enabled ones.
    expect(
      within(card).queryByText(/All People directory \(LDAP\) installations/)
    ).not.toBeInTheDocument();
    expect(within(card).getByText(/\(2 now\)/)).toBeInTheDocument();
    const generic = screen.getByTestId('app-integrations');
    expect(within(generic).queryByText('draw.io')).not.toBeInTheDocument();
    expect(within(generic).getByText('GovData')).toBeInTheDocument();
    expect(screen.getByTestId('app-integrations-hidden')).toHaveTextContent('(3)');
    // A disabled iAssistant the app does not use gets no panel.
    expect(screen.queryByText('Enable iAssistant')).not.toBeInTheDocument();
  });

  it('keeps a disabled installation the app binds, marked disabled', async () => {
    mockFetchInstalled.mockResolvedValue({ items: DISABLED });
    renderSection({ id: 'a', integrations: { drawio: {}, corp: {}, iassistant: {} } });
    const checkbox = await screen.findByLabelText(/draw.io/);
    expect(screen.getByTestId('app-integrations')).toContainElement(checkbox);
    const row = checkbox.closest('div');
    expect(within(row).getByText('Disabled')).toBeInTheDocument();
    const card = screen.getByTestId('app-integrations-people-directories');
    expect(within(card).getByLabelText(/Corporate directory/)).toBeChecked();
    expect(screen.getByText('Enable iAssistant')).toBeInTheDocument();
    expect(screen.queryByTestId('app-integrations-hidden')).not.toBeInTheDocument();
  });
});

describe('IntegrationsConfigSection: storage providers', () => {
  const NEXTCLOUD = [
    {
      id: 'nextcloud',
      definition: 'com.intrafind/nextcloud',
      definitionName: 'Nextcloud',
      type: 'storage',
      builtIn: true,
      label: 'Head office'
    },
    {
      id: 'nextcloud-branch',
      definition: 'com.intrafind/nextcloud',
      definitionName: 'Nextcloud',
      type: 'storage',
      builtIn: true,
      label: 'Branch office',
      enabled: false
    }
  ];

  it('offers all storage providers, all of one provider and each installation, without actions', async () => {
    mockFetchInstalled.mockResolvedValue({ items: [...INSTALLED, ...NEXTCLOUD] });
    const onChange = renderSection({ id: 'a' });
    const card = await screen.findByTestId('app-integrations-storage-providers');
    expect(within(card).getByText('Storage providers')).toBeInTheDocument();
    // A new storage binding starts optional.
    fireEvent.click(within(card).getByRole('switch', { name: 'Enable storage providers' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)[0].integrations).toEqual({
      'type:storage': { required: false }
    });
  });

  it('lists all storage providers, all of one provider and each installation once enabled', async () => {
    mockFetchInstalled.mockResolvedValue({ items: [...INSTALLED, ...NEXTCLOUD] });
    renderSection({ id: 'a', integrations: { 'type:storage': { required: false } } });
    const card = await screen.findByTestId('app-integrations-storage-providers');
    expect(within(card).getByLabelText('All storage providers')).toBeChecked();
    // Branch office is disabled: not counted, not listed.
    expect(within(card).getByText(/\(2 now\)/)).toBeInTheDocument();
    expect(within(card).getByLabelText(/Head office/)).toBeInTheDocument();
    expect(within(card).queryByLabelText(/Branch office/)).not.toBeInTheDocument();
    // One enabled Nextcloud left: no "All Nextcloud installations" row.
    expect(within(card).queryByLabelText(/All Nextcloud installations/)).not.toBeInTheDocument();
  });

  it('shows a bound storage provider with the Required switch and no action list', async () => {
    mockFetchInstalled.mockResolvedValue({ items: NEXTCLOUD });
    renderSection({ id: 'a', integrations: { 'nextcloud-branch': { required: false } } });
    const card = await screen.findByTestId('app-integrations-storage-providers');
    expect(within(card).getByLabelText(/Branch office/)).toBeChecked();
    expect(within(card).getByLabelText(/Required/)).not.toBeChecked();
    expect(within(card).getByText(/the file picker offers the providers/)).toBeInTheDocument();
    expect(within(card).queryByText('Actions')).not.toBeInTheDocument();
    expect(mockFetchOne).not.toHaveBeenCalled();
    expect(screen.queryByTestId('stale-integration-nextcloud-branch')).not.toBeInTheDocument();
  });

  it('is hidden while no storage provider is installed and the app binds none', async () => {
    mockFetchInstalled.mockResolvedValue({
      items: INSTALLED.filter(item => item.type !== 'storage')
    });
    renderSection({ id: 'a' });
    await screen.findByTestId('app-integrations');
    expect(screen.queryByTestId('app-integrations-storage-providers')).not.toBeInTheDocument();
  });

  it('keeps the card while the app binds type:storage, and never calls it stale', async () => {
    mockFetchInstalled.mockResolvedValue({ items: [] });
    renderSection({ id: 'a', integrations: { 'type:storage': { required: false } } });
    const card = await screen.findByTestId('app-integrations-storage-providers');
    expect(within(card).getByLabelText(/All storage providers/)).toBeChecked();
    expect(screen.queryByTestId('stale-integration-type:storage')).not.toBeInTheDocument();
  });
});

describe('mergeInstallationDetails', () => {
  it('keeps every action once and survives an empty list', () => {
    expect(mergeInstallationDetails([])).toEqual({ actions: [], definition: null });
    const merged = mergeInstallationDetails([
      { definition: { id: 'd' }, actions: [{ name: 'a', title: 'first' }] },
      { definition: { id: 'd' }, actions: [{ name: 'a', title: 'second' }, { name: 'b' }] }
    ]);
    expect(merged.definition).toEqual({ id: 'd' });
    expect(merged.actions.map(a => [a.name, a.title])).toEqual([
      ['a', 'first'],
      ['b', undefined]
    ]);
  });
});

describe('webSearchEngines', () => {
  it('lists the engines in Auto’s order: Brave, Staan, Qwant, then the others by id', () => {
    const engines = webSearchEnginesOf([
      { id: 'zeta', type: 'web-search' },
      { id: 'qwant', type: 'web-search' },
      { id: 'jira' },
      { id: 'acme', type: 'web-search' },
      { id: 'staan', type: 'web-search' },
      { id: 'brave', type: 'web-search' }
    ]);
    expect(engines.map(engine => engine.id)).toEqual(['brave', 'staan', 'qwant', 'acme', 'zeta']);
    expect(webSearchEnginesOf(null)).toEqual([]);
  });

  it('tells what the engine an app names means', () => {
    const engines = [{ id: 'qwant' }, { id: 'brave', enabled: false }];
    expect(webSearchEngineStatus(undefined, engines)).toBe('auto');
    expect(webSearchEngineStatus('auto', engines)).toBe('auto');
    expect(webSearchEngineStatus('qwant', engines)).toBe('ok');
    expect(webSearchEngineStatus('brave', engines)).toBe('disabled');
    expect(webSearchEngineStatus('staan', engines)).toBe('missing');
    expect(webSearchEngineStatus('staan', null)).toBe('unknown');
  });
});
