// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Integrations → People directories, list and editor:
 *
 *   - the list's switch saves the whole file with one directory switched, and
 *     offers to enable the shipped "People search" app while it is off;
 *   - "Use for people search" (?authProvider=…&name=…) prefills a new entry that
 *     reuses the sign-in provider, and saving appends it to the list;
 *   - a new entry without id, URL or base DN is not sent;
 *   - the test panel posts the unsaved form and shows steps, the untrusted
 *     issuer and the mapped people.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  fetchPeopleDirectories: jest.fn(),
  savePeopleDirectories: jest.fn(),
  fetchPeopleDirectoryPresets: jest.fn(),
  testPeopleDirectory: jest.fn()
};
jest.mock('../../../client/src/api/peopleDirectoriesAdminApi', () => ({
  fetchPeopleDirectories: (...args) => mockApi.fetchPeopleDirectories(...args),
  savePeopleDirectories: (...args) => mockApi.savePeopleDirectories(...args),
  fetchPeopleDirectoryPresets: (...args) => mockApi.fetchPeopleDirectoryPresets(...args),
  testPeopleDirectory: (...args) => mockApi.testPeopleDirectory(...args)
}));

const mockToggleApps = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  toggleApps: (...args) => mockToggleApps(...args),
  fetchAdminGroups: () =>
    Promise.resolve({ groups: { authenticated: { id: 'authenticated', name: 'Authenticated' } } }),
  getAdminApiErrorMessage: err => err?.response?.data?.error || err?.message || 'error',
  translateText: jest.fn(),
  makeAdminApiCall: jest.fn()
}));
jest.mock('../../../client/src/features/admin/components/OpenApiToolEditor', () => ({
  CredentialRefSelect: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text =
    typeof defaultOrOptions === 'string' ? defaultOrOptions : options.defaultValue || key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  useTranslation: () => mockI18n
}));

const AdminPeopleDirectoriesPage =
  require('../../../client/src/features/admin/pages/AdminPeopleDirectoriesPage').default;
const AdminPeopleDirectoryEditPage =
  require('../../../client/src/features/admin/pages/AdminPeopleDirectoryEditPage').default;

const X500 = {
  id: 'x500bund',
  enabled: false,
  type: 'ldap',
  url: 'ldaps://x500.bund.de:636',
  baseDn: 'o=Bund,c=DE',
  preset: 'ivbb',
  bind: { mode: 'anonymous' },
  tlsCa: ['pca-1-verwaltung-23'],
  groups: ['authenticated'],
  dataFlow: 'external',
  name: { en: 'Federal directory (IVBB)', de: 'Verzeichnisdienst des Bundes (IVBB)' }
};
const LEGACY = {
  id: 'legacy',
  enabled: true,
  type: 'ldap',
  url: 'ldap://ldap.corp.local:389',
  baseDn: 'dc=corp,dc=local',
  allowPlaintext: true,
  groups: ['authenticated'],
  dataFlow: 'internal',
  name: { en: 'Legacy directory' }
};
const LISTING = {
  directories: [X500, LEGACY],
  effective: {
    x500bund: {
      sourceType: 'direct',
      source: 'x500.bund.de',
      preset: 'ivbb',
      transport: 'ldaps',
      external: true,
      problems: [],
      warnings: []
    },
    legacy: {
      sourceType: 'direct',
      source: 'ldap.corp.local',
      preset: 'openldap',
      transport: 'plaintext',
      external: false,
      problems: [],
      warnings: []
    }
  },
  ldapProviders: [
    {
      name: 'corp-ad',
      displayName: 'Corporate AD',
      url: 'ldaps://dc.corp.local:636',
      host: 'dc.corp.local',
      baseDn: 'dc=corp,dc=local',
      preset: 'activeDirectory',
      starttls: false,
      hasBindAccount: true
    }
  ],
  peopleSearchApp: { id: 'people-directory', exists: true, enabled: false }
};
const PRESETS = {
  presets: [
    {
      id: 'activeDirectory',
      label: 'Active Directory',
      personFilter: '(objectClass=user)',
      searchAttributes: ['cn', 'mail'],
      attributeMapping: { name: ['displayName'], jobTitle: ['title'] }
    },
    {
      id: 'ivbb',
      label: 'IVBB directory (x500.bund.de)',
      personFilter: '(objectClass=ivbbPerson)',
      searchAttributes: ['cn', 'sn', 'givenName', 'mail'],
      attributeMapping: { name: ['givenName sn', 'cn'], jobTitle: ['role'] }
    }
  ],
  fields: ['name', 'jobTitle', 'organization', 'location', 'email'],
  defaults: { maxResults: 10, timeoutMs: 8000, concurrency: 2, requestDelayMs: 0 },
  limits: { maxResults: 50, timeoutMs: 30000, concurrency: 10 }
};

function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/admin/integrations/people-directories"
          element={<AdminPeopleDirectoriesPage />}
        />
        <Route
          path="/admin/integrations/people-directories/:directoryId"
          element={<AdminPeopleDirectoryEditPage />}
        />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockToggleApps.mockReset();
  mockApi.fetchPeopleDirectories.mockResolvedValue(LISTING);
  mockApi.fetchPeopleDirectoryPresets.mockResolvedValue(PRESETS);
  mockApi.savePeopleDirectories.mockImplementation(async directories => ({
    success: true,
    directories
  }));
  mockToggleApps.mockResolvedValue({});
});

describe('people directory list', () => {
  test('shows source, badges and an accessible switch per directory', async () => {
    renderAt('/admin/integrations/people-directories');
    const federal = await screen.findByRole('switch', { name: 'Federal directory (IVBB)' });
    expect(federal).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Legacy directory' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    const federalRow = federal.closest('li');
    expect(within(federalRow).getByText('External')).toBeInTheDocument();
    expect(within(federalRow).getByText('x500.bund.de')).toBeInTheDocument();
    expect(within(federalRow).queryByText('Plain text')).not.toBeInTheDocument();
    const legacyRow = screen.getByRole('switch', { name: 'Legacy directory' }).closest('li');
    expect(within(legacyRow).getByText('Plain text')).toBeInTheDocument();
  });

  test('switching a directory on saves the whole list and offers the People search app', async () => {
    renderAt('/admin/integrations/people-directories');
    fireEvent.click(await screen.findByRole('switch', { name: 'Federal directory (IVBB)' }));

    await waitFor(() => expect(mockApi.savePeopleDirectories).toHaveBeenCalledTimes(1));
    expect(mockApi.savePeopleDirectories).toHaveBeenCalledWith([
      { ...X500, enabled: true },
      LEGACY
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Enable app' }));
    await waitFor(() => expect(mockToggleApps).toHaveBeenCalledWith(['people-directory'], true));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Enable app' })).not.toBeInTheDocument()
    );
  });

  test('switching a directory off makes no offer', async () => {
    renderAt('/admin/integrations/people-directories');
    fireEvent.click(await screen.findByRole('switch', { name: 'Legacy directory' }));
    await waitFor(() => expect(mockApi.savePeopleDirectories).toHaveBeenCalled());
    expect(mockApi.savePeopleDirectories.mock.calls[0][0][1]).toEqual({
      ...LEGACY,
      enabled: false
    });
    await screen.findByText('"Legacy directory" is off.');
    expect(screen.queryByRole('button', { name: 'Enable app' })).not.toBeInTheDocument();
  });

  test('a switch writes onto the stored list, so a save made meanwhile elsewhere is kept', async () => {
    const added = { id: 'corp', authProvider: 'corp-ad', enabled: true };
    mockApi.fetchPeopleDirectories
      .mockResolvedValueOnce(LISTING)
      .mockResolvedValue({ ...LISTING, directories: [...LISTING.directories, added] });
    renderAt('/admin/integrations/people-directories');
    fireEvent.click(await screen.findByRole('switch', { name: 'Federal directory (IVBB)' }));

    await waitFor(() => expect(mockApi.savePeopleDirectories).toHaveBeenCalledTimes(1));
    expect(mockApi.savePeopleDirectories).toHaveBeenCalledWith([
      { ...X500, enabled: true },
      LEGACY,
      added
    ]);
  });

  test('every switch and delete button waits while a save is in flight', async () => {
    let finish;
    mockApi.savePeopleDirectories.mockImplementation(
      directories =>
        new Promise(resolve => {
          finish = () => resolve({ success: true, directories });
        })
    );
    renderAt('/admin/integrations/people-directories');
    fireEvent.click(await screen.findByRole('switch', { name: 'Federal directory (IVBB)' }));
    await waitFor(() => expect(mockApi.savePeopleDirectories).toHaveBeenCalledTimes(1));

    const legacy = screen.getByRole('switch', { name: 'Legacy directory' });
    expect(legacy).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: /^Delete / })) {
      expect(button).toBeDisabled();
    }
    fireEvent.click(legacy);
    finish();
    await waitFor(() => expect(legacy).not.toBeDisabled());
    expect(mockApi.savePeopleDirectories).toHaveBeenCalledTimes(1);
  });

  test('switching a directory deleted meanwhile saves nothing and reloads the list', async () => {
    mockApi.fetchPeopleDirectories
      .mockResolvedValueOnce(LISTING)
      .mockResolvedValue({ ...LISTING, directories: [LEGACY] });
    renderAt('/admin/integrations/people-directories');
    fireEvent.click(await screen.findByRole('switch', { name: 'Federal directory (IVBB)' }));

    expect(
      await screen.findByText(
        '"Federal directory (IVBB)" no longer exists. The list has been reloaded.'
      )
    ).toBeInTheDocument();
    expect(mockApi.savePeopleDirectories).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('switch', { name: 'Federal directory (IVBB)' })
    ).not.toBeInTheDocument();
  });

  test('a failed save shows the schema issues', async () => {
    mockApi.savePeopleDirectories.mockRejectedValue({
      response: {
        status: 400,
        data: {
          error: 'Invalid people directory configuration',
          details: [{ path: ['directories', 0, 'tlsCa', 0], message: 'Not a certificate name' }]
        }
      }
    });
    renderAt('/admin/integrations/people-directories');
    fireEvent.click(await screen.findByRole('switch', { name: 'Federal directory (IVBB)' }));
    expect(
      await screen.findByText(
        'Invalid people directory configuration (directories.0.tlsCa.0: Not a certificate name)'
      )
    ).toBeInTheDocument();
  });
});

describe('people directory editor', () => {
  test('"Use for people search" prefills a provider entry, and saving appends it', async () => {
    renderAt('/admin/integrations/people-directories/new?authProvider=corp-ad&name=Corporate%20AD');

    const id = await screen.findByLabelText('ID');
    expect(id).toHaveValue('corp-ad');
    expect(screen.getByLabelText('Reuse a sign-in provider')).toBeChecked();
    expect(screen.getByLabelText('Sign-in provider')).toHaveValue('corp-ad');
    // The provider's values are shown, and the preset mapping follows its type.
    expect(screen.getByText('dc=corp,dc=local')).toBeInTheDocument();
    expect(screen.getByText('Preset: (objectClass=user)')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Description (EN)'), {
      target: { value: 'Employees of our company.' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save directory' }));

    await waitFor(() => expect(mockApi.savePeopleDirectories).toHaveBeenCalledTimes(1));
    expect(mockApi.savePeopleDirectories).toHaveBeenCalledWith([
      X500,
      LEGACY,
      {
        id: 'corp-ad',
        enabled: true,
        type: 'ldap',
        authProvider: 'corp-ad',
        groups: ['authenticated'],
        dataFlow: 'internal',
        name: { en: 'Corporate AD', de: 'Corporate AD' },
        description: { en: 'Employees of our company.' }
      }
    ]);

    // Back on the list, with the result and the app offer.
    expect(await screen.findByText('Directory "corp-ad" saved.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Enable app' })).toBeInTheDocument();
  });

  test('saving a directory changed elsewhere meanwhile warns once, then overwrites', async () => {
    const changed = { ...LEGACY, name: { en: 'Renamed elsewhere' } };
    mockApi.fetchPeopleDirectories
      .mockResolvedValueOnce(LISTING)
      .mockResolvedValue({ ...LISTING, directories: [X500, changed] });
    renderAt('/admin/integrations/people-directories/legacy');
    await screen.findByLabelText('ID');

    fireEvent.click(screen.getByRole('button', { name: 'Save directory' }));
    expect(await screen.findByText(/This directory was changed elsewhere/)).toBeInTheDocument();
    expect(mockApi.savePeopleDirectories).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save directory' }));
    await waitFor(() => expect(mockApi.savePeopleDirectories).toHaveBeenCalledTimes(1));
  });

  test('saving a directory nobody else changed saves at once', async () => {
    renderAt('/admin/integrations/people-directories/legacy');
    await screen.findByLabelText('ID');
    fireEvent.click(screen.getByRole('button', { name: 'Save directory' }));
    await waitFor(() => expect(mockApi.savePeopleDirectories).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/This directory was changed elsewhere/)).not.toBeInTheDocument();
  });

  test('values typed for a direct connection stay visible as overrides of a provider', async () => {
    renderAt('/admin/integrations/people-directories/new');
    await screen.findByLabelText('ID');
    fireEvent.change(screen.getByLabelText('URL', { exact: false }), {
      target: { value: 'ldap://typo-host:389' }
    });
    fireEvent.click(screen.getByLabelText('Reuse a sign-in provider'));

    expect(document.getElementById('pd-source-overrides')).not.toHaveAttribute('hidden');
    expect(document.getElementById('pd-url')).toHaveValue('ldap://typo-host:389');
  });

  test("the search base defaults to the provider's user search base", async () => {
    mockApi.fetchPeopleDirectories.mockResolvedValue({
      ...LISTING,
      ldapProviders: LISTING.ldapProviders.map(provider => ({
        ...provider,
        userSearchBase: 'ou=Staff,dc=corp,dc=local'
      }))
    });
    renderAt('/admin/integrations/people-directories/new?authProvider=corp-ad&name=Corporate%20AD');
    await screen.findByLabelText('ID');
    expect(screen.getByLabelText('Search base', { exact: false })).toHaveAttribute(
      'placeholder',
      'ou=Staff,dc=corp,dc=local'
    );
  });

  test('a new entry without id, URL and base DN is not sent', async () => {
    renderAt('/admin/integrations/people-directories/new');
    await screen.findByLabelText('ID');
    fireEvent.click(screen.getByRole('button', { name: 'Save directory' }));

    expect(await screen.findByText('Enter an id.')).toBeInTheDocument();
    expect(screen.getByText('Enter the directory URL.')).toBeInTheDocument();
    expect(screen.getByText('Enter the base DN.')).toBeInTheDocument();
    expect(mockApi.savePeopleDirectories).not.toHaveBeenCalled();
  });

  test('the LDAP browser section switches the browser on with its own groups and account', async () => {
    renderAt('/admin/integrations/people-directories/x500bund');
    await screen.findByLabelText('ID');
    expect(screen.queryByLabelText('Browse base')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Offer the LDAP browser'));
    expect(screen.getByText(/x500bund__browse_search/)).toBeInTheDocument();
    // The default: the directory's account, with a warning about its reach.
    expect(document.getElementById('pd-browse-bind-mode-directory')).toBeChecked();
    expect(screen.getByText(/full reach of the people search account/)).toBeInTheDocument();
    expect(screen.getByLabelText('Browse base')).toHaveAttribute('placeholder', 'o=Bund,c=DE');

    // An account of its own needs a DN and a credential.
    fireEvent.click(document.getElementById('pd-browse-bind-mode-service'));
    fireEvent.click(screen.getByRole('button', { name: 'Save directory' }));
    expect(await screen.findByText('Please check these fields')).toBeInTheDocument();
    expect(mockApi.savePeopleDirectories).not.toHaveBeenCalled();

    fireEvent.click(document.getElementById('pd-browse-bind-mode-anonymous'));
    fireEvent.change(screen.getByLabelText('Browse base'), {
      target: { value: 'ou=MRI,o=Bund,c=DE' }
    });
    fireEvent.change(screen.getByLabelText('Further attributes to withhold'), {
      target: { value: 'info\nsecretNote' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save directory' }));

    await waitFor(() => expect(mockApi.savePeopleDirectories).toHaveBeenCalledTimes(1));
    const saved = mockApi.savePeopleDirectories.mock.calls[0][0].find(d => d.id === 'x500bund');
    expect(saved.browse).toEqual({
      enabled: true,
      groups: ['admins'],
      base: 'ou=MRI,o=Bund,c=DE',
      bind: { mode: 'anonymous' },
      denyAttributes: ['info', 'secretNote']
    });
  });

  test('editing a plain-text directory warns until plain text is allowed', async () => {
    renderAt('/admin/integrations/people-directories/legacy');
    expect(await screen.findByLabelText('ID')).toHaveAttribute('readonly');
    expect(screen.getAllByText('Plain text').length).toBeGreaterThan(0);
    const allow = screen.getByLabelText('Allow plain-text connections (ldap:// without StartTLS)');
    expect(allow).toBeChecked();
    fireEvent.click(allow);
    expect(
      screen.getByText(/iHub refuses the connection until plain text is allowed here/)
    ).toBeInTheDocument();
  });

  test('the test panel posts the unsaved form and shows steps, issuer and people', async () => {
    mockApi.testPeopleDirectory.mockResolvedValue({
      success: false,
      message: 'Connect failed',
      summary: { ok: 1, warn: 0, fail: 1, durationMs: 40 },
      steps: [
        { id: 'configuration', label: 'Effective configuration', status: 'ok', message: 'fine' },
        {
          id: 'connect',
          label: 'Connect',
          status: 'fail',
          message: 'certificate not trusted',
          details: { errorCode: 'UNABLE_TO_GET_ISSUER_CERT', missingIssuer: 'PCA-1-Verwaltung-23' },
          hints: ['Install "PCA-1-Verwaltung-23" in the operating system\'s certificate store']
        }
      ],
      results: [
        {
          directory: 'x500bund',
          personId: 'cn=Mustermann Erika,l=Karlsruhe,ou=MRI,o=Bund,c=DE',
          name: 'Erika Mustermann',
          jobTitle: 'Vertreterin des Präsidenten',
          organization: 'MRI',
          location: 'Karlsruhe',
          email: null
        }
      ]
    });
    renderAt('/admin/integrations/people-directories/x500bund');
    await screen.findByLabelText('ID');
    // An unsaved change is part of what is tested.
    fireEvent.change(screen.getByRole('textbox', { name: 'Base DN' }), {
      target: { value: 'ou=MRI,o=Bund,c=DE' }
    });
    fireEvent.change(screen.getByLabelText('Name to search for (optional)'), {
      target: { value: 'Mustermann' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    await waitFor(() => expect(mockApi.testPeopleDirectory).toHaveBeenCalledTimes(1));
    const [target, query] = mockApi.testPeopleDirectory.mock.calls[0];
    expect(query).toBe('Mustermann');
    expect(target.directory).toMatchObject({ id: 'x500bund', baseDn: 'ou=MRI,o=Bund,c=DE' });

    expect(await screen.findByText('certificate not trusted')).toBeInTheDocument();
    expect(screen.getByText(/Install "PCA-1-Verwaltung-23"/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Mapped results (1)' });
    expect(within(table).getByText('Vertreterin des Präsidenten')).toBeInTheDocument();
    // Fields without a value in any result get no column.
    expect(within(table).queryByText('E-mail')).not.toBeInTheDocument();
    expect(mockApi.savePeopleDirectories).not.toHaveBeenCalled();
  });
});
