// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * App editor → Integrations: each integration in one place. Web search and
 * iAssistant keep their own panels (shown while installed or in use), the
 * people directories get a card with "All people directories"
 * (`type:people-directory`), and the generic list never repeats web search,
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

const INSTALLED = [
  { id: 'websearch', definition: 'com.intrafind/web-search', type: 'web-search', builtIn: true },
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
    expect(within(generic).queryByText('websearch')).not.toBeInTheDocument();
    expect(within(generic).queryByText('iassistant')).not.toBeInTheDocument();
    expect(within(generic).queryByText('office365')).not.toBeInTheDocument();
    // The rest is grouped.
    expect(within(generic).getByText('MCP servers')).toBeInTheDocument();
    expect(within(generic).getByText('Built-in')).toBeInTheDocument();
    expect(within(generic).getByText('From the catalog')).toBeInTheDocument();
    expect(within(generic).getByText('GovData')).toBeInTheDocument();
  });

  it('hides the web search and iAssistant panels while they are not installed and unused', async () => {
    mockFetchInstalled.mockResolvedValue({
      items: INSTALLED.filter(i => i.id !== 'websearch' && i.id !== 'iassistant')
    });
    renderSection({ id: 'a' });
    await screen.findByTestId('app-integrations-people-directories');
    expect(screen.queryByText('Web Search')).not.toBeInTheDocument();
    expect(screen.queryByText('Enable iAssistant')).not.toBeInTheDocument();
  });

  it('keeps a panel the app already uses, with a notice that it is not installed', async () => {
    mockFetchInstalled.mockResolvedValue({ items: [] });
    renderSection({ id: 'a', websearch: { enabled: true } });
    expect(await screen.findByText('Web Search')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Web Search is not installed');
  });

  it('binds every people directory with the type key', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    const onChange = renderSection({ id: 'a' });
    const card = await screen.findByTestId('app-integrations-people-directories');
    expect(within(card).getByText('Corporate directory')).toBeInTheDocument();
    expect(within(card).getByText('Entra ID')).toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText(/All people directories/));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)[0].integrations).toEqual({ 'type:people-directory': {} });
  });

  it('binds the iAssistant installation from inside its panel', async () => {
    mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
    const onChange = renderSection({ id: 'a' });
    fireEvent.click(await screen.findByLabelText(/Use in this app/));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)[0].integrations).toEqual({ iassistant: {} });
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
