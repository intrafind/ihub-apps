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
  it('offers "*", the type rows and every installation, grouped', async () => {
    renderSection({ id: 'g', permissions: { integrations: [] } });
    await screen.findByText('Corp');
    expect(screen.getByLabelText(/All integrations/)).not.toBeChecked();
    for (const label of [
      'All people directories',
      'All web search engines',
      'All storage providers'
    ]) {
      expect(screen.getByLabelText(new RegExp(label))).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/All CKAN installations/)).toBeInTheDocument();
    const mcp = screen.getByTestId('group-integrations-mcp');
    expect(within(mcp).getByText('draw.io')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('group-integrations-a2a')).getByText('Langdock')
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('group-integrations-builtIn')).getByText('iHub tools')
    ).toBeInTheDocument();
    expect(screen.getByText(/ckan-b · disabled/)).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
    expect(screen.getByText('Members of this group may use no integration.')).toBeInTheDocument();
  });

  it('grants an installation, a type and everything', async () => {
    const onChange = renderSection({ id: 'g', permissions: { integrations: ['corp'] } });
    await screen.findByText('Corp');
    fireEvent.click(screen.getByLabelText(/^IVBB/));
    expect(onChange).toHaveBeenLastCalledWith(['corp', 'x500bund']);
    fireEvent.click(screen.getByLabelText(/All storage providers/));
    expect(onChange).toHaveBeenLastCalledWith(['corp', 'type:storage']);
    fireEvent.click(screen.getByLabelText(/^Corp/));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByLabelText(/All integrations/));
    expect(onChange).toHaveBeenLastCalledWith(['*']);
  });

  it('shows installations a broader key of the group covers as ticked and locked', async () => {
    renderSection({ id: 'g', permissions: { integrations: ['type:people-directory'] } });
    await screen.findByText('Corp');
    const corp = screen.getByLabelText(/^Corp/);
    expect(corp).toBeChecked();
    expect(corp).toBeDisabled();
    expect(screen.getAllByText('with All people directories')).toHaveLength(2);
    expect(screen.getByLabelText(/^draw\.io/)).not.toBeChecked();
  });

  it('shows what the group inherits, read-only, with the group it comes from', async () => {
    renderSection({ id: 'admins', inherits: ['users'], permissions: { integrations: ['drawio'] } });
    await screen.findByText('Corp');
    const corp = screen.getByLabelText(/^Corp/);
    expect(corp).toBeChecked();
    expect(corp).toBeDisabled();
    expect(screen.getAllByText('via users').length).toBeGreaterThan(0);
    expect(screen.getAllByText('via authenticated').length).toBeGreaterThan(0);
    const web = screen.getByLabelText(/All web search engines/);
    expect(web).toBeChecked();
    expect(web).toBeDisabled();
    // The group's own grant stays editable.
    expect(screen.getByLabelText(/^draw\.io/)).toBeEnabled();
    expect(screen.getByText(/granted by a group this one inherits/)).toBeInTheDocument();
  });

  it('locks every row when an inherited group grants everything', async () => {
    renderSection({ id: 'g', inherits: ['everyone'], permissions: { integrations: [] } });
    await screen.findByText('Corp');
    const all = screen.getByLabelText(/All integrations/);
    expect(all).toBeChecked();
    expect(all).toBeDisabled();
    expect(screen.getByLabelText(/^Langdock/)).toBeDisabled();
    expect(screen.getAllByText('via everyone').length).toBeGreaterThan(3);
  });

  it('keeps keys the list does not show removable', async () => {
    const onChange = renderSection({ id: 'g', permissions: { integrations: [LDAP, 'old'] } });
    await screen.findByText('Corp');
    const other = screen.getByTestId('group-integrations-other');
    expect(within(other).getByText(LDAP)).toBeInTheDocument();
    fireEvent.click(within(other).getByLabelText('Remove old'));
    expect(onChange).toHaveBeenLastCalledWith([LDAP]);
    // The definition grant covers both directories.
    expect(screen.getByLabelText(/^Corp/)).toBeChecked();
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
