// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * Group editor → Integrations (#3093): `permissions.integrations` as `*`,
 * installations grouped like the admin Integrations page, "All …" rows for
 * the types (`type:people-directory`, `type:web-search`, `type:storage`) and
 * for a definition with several installations, and what the group inherits,
 * read-only ("via users").
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
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...args) => mockFetchInstalled(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'failed'
}));

import GroupIntegrationsSection from '../../../client/src/features/admin/components/GroupIntegrationsSection';
import {
  grantingKey,
  inheritedGrants,
  sectionsOf,
  toggleKey,
  unlistedKeys
} from '../../../client/src/features/admin/utils/groupIntegrationAccess';

const LDAP = 'com.intrafind/ldap-directory';
const INSTALLED = [
  { id: 'corp', definition: LDAP, type: 'people-directory', builtIn: true, label: 'Corp' },
  { id: 'x500bund', definition: LDAP, type: 'people-directory', builtIn: true, label: 'IVBB' },
  { id: 'brave', definition: 'com.intrafind/brave-search', type: 'web-search', builtIn: true },
  { id: 'office365', definition: 'com.intrafind/office365', type: 'storage', builtIn: true },
  { id: 'drawio', definition: 'mcp/drawio', protocol: 'mcp', builtIn: true, label: 'draw.io' },
  { id: 'langdock', definition: 'com.intrafind/a2a-agent', protocol: 'a2a', label: 'Langdock' },
  { id: 'ihub', definition: 'com.intrafind/ihub', builtIn: true, label: 'iHub tools' },
  { id: 'ckan-a', definition: 'org.ckan/portal', definitionName: 'CKAN', label: 'GovData' },
  {
    id: 'ckan-b',
    definition: 'org.ckan/portal',
    definitionName: 'CKAN',
    label: 'City',
    enabled: false
  },
  { id: 'gone', definition: 'x/missing', definitionMissing: true }
];

const GROUPS = {
  users: { id: 'users', inherits: ['authenticated'], permissions: { integrations: [LDAP] } },
  authenticated: { id: 'authenticated', permissions: { integrations: ['type:web-search'] } },
  everyone: { id: 'everyone', permissions: { integrations: ['*'] } }
};

function renderSection(group, onChange = jest.fn(), groups = GROUPS) {
  render(<GroupIntegrationsSection group={group} groups={groups} onChange={onChange} />);
  return onChange;
}

beforeEach(() => {
  mockFetchInstalled.mockReset();
  mockFetchInstalled.mockResolvedValue({ items: INSTALLED });
});

describe('group integration helpers', () => {
  it('groups installations like the admin page, with type and definition rows', () => {
    const sections = sectionsOf(INSTALLED);
    expect(sections.map(s => s.id)).toEqual([
      'peopleDirectories',
      'webSearch',
      'storage',
      'mcp',
      'a2a',
      'builtIn',
      'catalog'
    ]);
    expect(sections[0].items.map(i => i.id)).toEqual(['corp', 'x500bund']);
    expect(sections.find(s => s.id === 'builtIn').items.map(i => i.id)).toEqual(['ihub']);
    expect(sections.find(s => s.id === 'catalog').definitions).toEqual([
      { id: 'org.ckan/portal', name: 'CKAN', count: 2 }
    ]);
    // A type section stays even when nothing of the type is installed.
    expect(sectionsOf([]).map(s => s.id)).toEqual(['peopleDirectories', 'webSearch', 'storage']);
  });

  it('finds the broadest key that grants an installation', () => {
    const corp = INSTALLED[0];
    expect(grantingKey(corp, ['corp'])).toBe('corp');
    expect(grantingKey(corp, ['corp', LDAP])).toBe(LDAP);
    expect(grantingKey(corp, ['type:people-directory', 'corp'])).toBe('type:people-directory');
    expect(grantingKey(corp, ['*'])).toBe('*');
    expect(grantingKey(corp, ['websearch'])).toBeNull();
  });

  it('collects inherited keys with the groups they come from, transitively', () => {
    const inherited = inheritedGrants('admins', GROUPS, ['users']);
    expect(Object.fromEntries(inherited)).toEqual({
      [LDAP]: ['users'],
      'type:web-search': ['authenticated']
    });
    expect(inheritedGrants('users', GROUPS).get('type:web-search')).toEqual(['authenticated']);
    expect(inheritedGrants('loner', GROUPS).size).toBe(0);
  });

  it('toggles keys, "*" replacing the list, and keeps unknown keys visible', () => {
    expect(toggleKey(['corp'], 'websearch', true)).toEqual(['corp', 'websearch']);
    expect(toggleKey(['corp'], '*', true)).toEqual(['*']);
    expect(toggleKey(['corp', 'websearch'], 'corp', false)).toEqual(['websearch']);
    expect(
      unlistedKeys(['corp', LDAP, 'old-portal', 'type:storage'], sectionsOf(INSTALLED))
    ).toEqual([LDAP, 'old-portal']);
  });
});

describe('GroupIntegrationsSection', () => {
  const picker = () => screen.getByLabelText('Add integration');
  const optionLabels = () =>
    within(picker())
      .getAllByRole('option')
      .map(o => o.textContent);

  it('shows nothing but a hint for a group without integrations', async () => {
    renderSection({ id: 'g', permissions: { integrations: [] } });
    await screen.findByLabelText('Add integration');
    expect(screen.getByText('Members of this group may use no integration.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('group-integrations-selected')).queryByText('Corp')
    ).not.toBeInTheDocument();
  });

  it('offers "All integrations", the type entries and every installation, grouped', async () => {
    renderSection({ id: 'g', permissions: { integrations: [] } });
    await screen.findByLabelText('Add integration');
    const labels = optionLabels();
    for (const label of [
      'All integrations',
      'All people directories',
      'All web search engines',
      'All storage providers',
      'All CKAN installations',
      'Corp',
      'IVBB',
      'draw.io',
      'Langdock',
      'iHub tools',
      'GovData',
      'City (disabled)'
    ]) {
      expect(labels).toContain(label);
    }
    expect(labels).not.toContain('gone');
    expect(
      within(picker())
        .getAllByRole('group')
        .map(g => g.getAttribute('label'))
    ).toContain('MCP servers');
  });

  it('adds an installation, a type and everything', async () => {
    const onChange = renderSection({ id: 'g', permissions: { integrations: ['corp'] } });
    await screen.findByLabelText('Add integration');
    fireEvent.change(picker(), { target: { value: 'x500bund' } });
    expect(onChange).toHaveBeenLastCalledWith(['corp', 'x500bund']);
    fireEvent.change(picker(), { target: { value: 'type:storage' } });
    expect(onChange).toHaveBeenLastCalledWith(['corp', 'type:storage']);
    fireEvent.change(picker(), { target: { value: '*' } });
    expect(onChange).toHaveBeenLastCalledWith(['*']);
  });

  it('shows only the added integrations and removes one', async () => {
    const onChange = renderSection({
      id: 'g',
      permissions: { integrations: ['corp', 'type:web-search'] }
    });
    await screen.findByLabelText('Add integration');
    const selected = screen.getByTestId('group-integrations-selected');
    expect(within(selected).getByText('Corp')).toBeInTheDocument();
    expect(within(selected).getByText('All web search engines')).toBeInTheDocument();
    expect(within(selected).queryByText('IVBB')).not.toBeInTheDocument();
    // What is added already is not offered again, nor what a broader entry covers.
    expect(optionLabels()).not.toContain('Corp');
    expect(optionLabels()).not.toContain('All web search engines');
    expect(optionLabels()).not.toContain('brave');
    fireEvent.click(screen.getByLabelText('Remove Corp'));
    expect(onChange).toHaveBeenLastCalledWith(['type:web-search']);
  });

  it('shows "All integrations" alone, without the list to add more', async () => {
    renderSection({ id: 'g', permissions: { integrations: ['*', 'corp'] } });
    await waitFor(() => expect(mockFetchInstalled).toHaveBeenCalled());
    await screen.findByText('All integrations');
    const selected = screen.getByTestId('group-integrations-selected');
    expect(within(selected).getAllByRole('listitem')).toHaveLength(1);
    expect(within(selected).queryByText('Corp')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add integration')).not.toBeInTheDocument();
  });

  it('shows what the group inherits, read-only, with the group it comes from', async () => {
    renderSection({ id: 'admins', inherits: ['users'], permissions: { integrations: ['drawio'] } });
    await screen.findByLabelText('Add integration');
    const inherited = screen.getAllByTestId('group-integrations-inherited');
    expect(inherited.map(entry => entry.textContent)).toEqual([
      `${LDAP}via users`,
      'All web search enginesvia authenticated'
    ]);
    for (const entry of inherited) expect(within(entry).queryByRole('button')).toBeNull();
    // What a parent grants is not offered again.
    expect(optionLabels()).not.toContain('All web search engines');
    expect(optionLabels()).not.toContain('Corp');
    expect(optionLabels()).toContain('Langdock');
  });

  it('offers nothing to add when an inherited group grants everything', async () => {
    renderSection({ id: 'g', inherits: ['everyone'], permissions: { integrations: [] } });
    await screen.findByText('All integrations');
    expect(screen.getByText('via everyone')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add integration')).not.toBeInTheDocument();
  });

  it('keeps entries the list does not know visible and removable', async () => {
    const onChange = renderSection({ id: 'g', permissions: { integrations: [LDAP, 'old'] } });
    await screen.findByLabelText('Add integration');
    const selected = screen.getByTestId('group-integrations-selected');
    expect(within(selected).getByText('old')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove old'));
    expect(onChange).toHaveBeenLastCalledWith([LDAP]);
  });

  it('reports a failed load', async () => {
    mockFetchInstalled.mockRejectedValueOnce(new Error('offline'));
    renderSection({ id: 'g', permissions: { integrations: [] } });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not load the installed integrations: offline'
      )
    );
  });
});
