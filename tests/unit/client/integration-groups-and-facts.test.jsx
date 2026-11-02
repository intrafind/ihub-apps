// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The pure helpers of Admin → Integrations:
 *
 *   - `groupIntegrations` sorts installations and catalog definitions into the
 *     groups both tabs show, in order, without empty groups;
 *   - `installationFacts` picks the key facts of an installation per
 *     definition, protocol or the generic rule, and never shows a secret;
 *   - `appsBindingInstallation` finds the apps binding an installation by id,
 *     definition id or `type:<type>`;
 *   - `buildInstallationPayload` sends back what an editor did not change.
 */
import {
  INTEGRATION_GROUPS,
  groupIntegrations,
  integrationGroupOf
} from '../../../client/src/features/admin/components/integrations/integrationGroups';
import {
  installationFacts,
  isSecretField
} from '../../../client/src/features/admin/components/integrations/integrationFacts';
import { appsBindingInstallation } from '../../../client/src/features/admin/components/integrations/integrationBindings';
import { groupsGranting } from '../../../client/src/features/admin/utils/groupIntegrationAccess';
import {
  buildInstallationPayload,
  mergedLabel
} from '../../../client/src/features/admin/components/integrations/installationPayload';

describe('integration groups', () => {
  test('one rule sorts installations and catalog definitions', () => {
    expect(integrationGroupOf({ type: 'people-directory', builtIn: true })).toBe(
      'people-directories'
    );
    expect(integrationGroupOf({ type: 'web-search', builtIn: true })).toBe('web-search');
    expect(integrationGroupOf({ type: 'storage', builtIn: true, protocol: 'native' })).toBe(
      'storage'
    );
    // The type wins over the protocol, the protocol over "built-in".
    expect(integrationGroupOf({ protocol: 'mcp', builtIn: true })).toBe('mcp');
    expect(integrationGroupOf({ protocol: 'a2a', builtIn: true })).toBe('agents');
    expect(integrationGroupOf({ protocol: 'native', builtIn: true })).toBe('built-in');
    expect(integrationGroupOf({ protocol: 'openapi', builtIn: false })).toBe('catalog');
    expect(integrationGroupOf({ protocol: 'openapi' })).toBe('catalog');
    expect(integrationGroupOf(null)).toBe('catalog');
  });

  test('groups come in the fixed order, empty ones left out, entries in their order', () => {
    const entries = [
      { id: 'govdata', protocol: 'openapi' },
      { id: 'ifinder', protocol: 'native', builtIn: true },
      { id: 'drawio', protocol: 'mcp', builtIn: true },
      { id: 'office365', type: 'storage', protocol: 'native', builtIn: true },
      { id: 'x500bund', type: 'people-directory', protocol: 'native', builtIn: true },
      { id: 'websearch', type: 'web-search', protocol: 'native', builtIn: true },
      { id: 'excalidraw', protocol: 'mcp', builtIn: true },
      { id: 'iassistant', protocol: 'native', builtIn: true }
    ];
    const groups = groupIntegrations(entries);
    expect(groups.map(g => g.id)).toEqual([
      'people-directories',
      'web-search',
      'storage',
      'mcp',
      'built-in',
      'catalog'
    ]);
    expect(groups.find(g => g.id === 'mcp').items.map(i => i.id)).toEqual(['drawio', 'excalidraw']);
    expect(groups.find(g => g.id === 'built-in').items.map(i => i.id)).toEqual([
      'ifinder',
      'iassistant'
    ]);
    // Each group carries its heading and description keys.
    for (const group of groups) {
      expect(group.titleKey).toMatch(/^admin\.integrations\.groups\./);
      expect(group.descriptionKey).toMatch(/^admin\.integrations\.groups\./);
    }
  });

  test('nothing in, no group out; the catalog group is last', () => {
    expect(groupIntegrations([])).toEqual([]);
    expect(groupIntegrations(undefined)).toEqual([]);
    expect(INTEGRATION_GROUPS.map(g => g.id)).toEqual([
      'people-directories',
      'web-search',
      'storage',
      'mcp',
      'agents',
      'built-in',
      'catalog'
    ]);
  });
});

/** The facts as `label: value` lines, values untranslated (keys' English defaults). */
function lines(facts) {
  return facts.map(f => `${f.labelDefault}: ${f.text ?? f.valueDefault}`);
}

describe('installation facts', () => {
  test('iFinder: base URL, sign-in, signing key, default search profile', () => {
    const facts = installationFacts({
      definition: 'com.intrafind/ifinder',
      values: { baseUrl: 'https://ifinder.example.com', privateKeyRef: 'ifinder-key' }
    });
    expect(lines(facts)).toEqual([
      'Base URL: https://ifinder.example.com',
      'Authentication: JWT signed by iHub',
      'Private key: set',
      'Default search profile: searchprofile-standard'
    ]);
    const exchange = installationFacts({
      definition: 'com.intrafind/ifinder',
      values: {
        baseUrl: 'https://ifinder.example.com',
        authMode: 'oidcTokenExchange',
        tokenExchangeProvider: 'zitadel'
      }
    });
    expect(lines(exchange)).toContain('OIDC provider: zitadel');
  });

  test('iAssistant names the iFinder installation it runs on', () => {
    const facts = installationFacts(
      {
        definition: 'com.intrafind/iassistant',
        values: { connection: 'ifinder', defaultProfileId: 'cHJvZmlsZQ==' }
      },
      { installations: [{ id: 'ifinder', label: 'Our iFinder' }] }
    );
    expect(lines(facts).slice(0, 2)).toEqual([
      'Runs on: Our iFinder (ifinder)',
      'Default profile: cHJvZmlsZQ=='
    ]);
  });

  test('directories, web search, storage, Jira, MCP and CKAN show their key values', () => {
    expect(
      lines(
        installationFacts({
          definition: 'com.intrafind/ldap-directory',
          values: { url: 'ldaps://x500.bund.de', baseDn: 'o=Bund,c=DE' }
        })
      )
    ).toEqual(['Directory URL: ldaps://x500.bund.de', 'Base DN: o=Bund,c=DE']);
    expect(
      lines(
        installationFacts({
          definition: 'com.intrafind/entra-directory',
          values: { tenantId: 'tenant-1', clientId: 'client-1' }
        })
      )
    ).toEqual(['Tenant ID: tenant-1', 'Client ID: client-1', 'Client secret: not set']);
    expect(
      lines(
        installationFacts({
          definition: 'com.intrafind/web-search',
          values: { defaultProvider: 'brave', braveCredentialRef: 'brave-key' }
        })
      )
    ).toEqual(['Default engine: Brave Search', 'Brave API key: set', 'Staan API key: not set']);
    expect(
      lines(
        installationFacts({
          definition: 'com.intrafind/nextcloud',
          values: { serverUrl: 'https://cloud.example.com' }
        })
      )[0]
    ).toBe('Server URL: https://cloud.example.com');
    expect(
      lines(
        installationFacts({
          definition: 'com.intrafind/google-drive',
          values: { clientId: 'gd', sourceMyDrive: true, sourceSharedWithMe: false }
        })
      )
    ).toContain('Sources: My Drive, Shared drives');
    // Sources are on unless stored as off; all off says so.
    expect(
      lines(installationFacts({ definition: 'com.intrafind/office365', values: { tenantId: 't' } }))
    ).toEqual(['Tenant ID: t', 'Sources: OneDrive, SharePoint, Teams', 'Client secret: not set']);
    expect(
      lines(
        installationFacts({
          definition: 'com.intrafind/google-drive',
          values: { sourceMyDrive: false, sourceSharedDrives: false, sourceSharedWithMe: false }
        })
      )
    ).toContain('Sources: none');
    expect(
      lines(
        installationFacts({
          definition: 'com.intrafind/jira',
          values: { siteUrl: 'https://jira.example.com' }
        })
      )[0]
    ).toBe('Site URL: https://jira.example.com');
    expect(
      lines(
        installationFacts({
          definition: 'mcp/linear',
          protocol: 'mcp',
          values: { url: 'https://mcp.linear.app/mcp', transport: 'streamableHttp' },
          auth: { mode: 'oauth-user' }
        })
      )
    ).toEqual(['Server URL: https://mcp.linear.app/mcp', 'Transport: Streamable HTTP']);
    expect(
      lines(
        installationFacts({
          definition: 'org.ckan/open-data-portal',
          values: { baseUrl: 'https://www.govdata.de/ckan', maxRows: 5 },
          auth: { mode: 'service-account', credentialRef: 'integration:govdata' }
        })
      )
    ).toEqual([
      'Portal URL: https://www.govdata.de/ckan',
      'Results per search: 5',
      'Credential: set'
    ]);
  });

  test('an unknown definition shows its endpoint; at most four facts on a tile', () => {
    expect(
      lines(
        installationFacts({
          definition: 'org.example/custom',
          protocol: 'openapi',
          values: { baseUrl: 'https://api.example.com' }
        })
      )
    ).toEqual(['Endpoint: https://api.example.com']);
    const many = installationFacts({
      definition: 'com.intrafind/office365',
      values: {
        tenantId: 't',
        clientId: 'c',
        clientSecretRef: 'x',
        sourcePersonalDrive: true
      }
    });
    expect(many).toHaveLength(4);
    expect(
      installationFacts(
        {
          definition: 'com.intrafind/office365',
          values: { tenantId: 't', clientId: 'c', clientSecretRef: 'x', sourceTeams: true }
        },
        { limit: 2 }
      )
    ).toHaveLength(2);
  });

  test('a secret never reaches the output, only whether it is set', () => {
    const SECRET = 'S3CR3T-value-never-shown';
    const definition = {
      install: [
        { key: 'customToken', type: 'secret' },
        { key: 'customKey', type: 'credential' },
        { key: 'pin', type: 'string', sensitive: true }
      ]
    };
    // Every key that holds a secret or a reference to one carries it; the
    // plain values (URLs) carry harmless text.
    const values = {
      url: 'ldaps://ok.example',
      privateKeyRef: SECRET,
      clientSecretRef: SECRET,
      braveCredentialRef: SECRET,
      staanCredentialRef: SECRET,
      bindPasswordRef: SECRET,
      apiToken: SECRET,
      password: SECRET,
      customToken: SECRET,
      customKey: SECRET,
      pin: SECRET
    };
    const definitions = [
      'com.intrafind/ifinder',
      'com.intrafind/iassistant',
      'com.intrafind/ldap-directory',
      'com.intrafind/entra-directory',
      'com.intrafind/web-search',
      'com.intrafind/office365',
      'com.intrafind/google-drive',
      'com.intrafind/nextcloud',
      'com.intrafind/jira',
      'org.ckan/open-data-portal',
      'org.example/custom'
    ];
    for (const id of definitions) {
      for (const bindMode of ['service', 'anonymous']) {
        const item = {
          definition: id,
          protocol: 'openapi',
          values: { ...values, bindMode, baseUrl: 'https://ok.example' },
          auth: { mode: 'service-account', credentialRef: SECRET }
        };
        const facts = installationFacts(item, { definition, limit: 50 });
        const output = JSON.stringify(facts);
        expect(output).not.toContain(SECRET);
        for (const fact of facts.filter(f => f.secret)) {
          expect(fact.text).toBeUndefined();
          expect(['set', 'unset']).toContain(fact.secret);
        }
      }
    }
    expect(isSecretField('customToken', { definition })).toBe(true);
    expect(isSecretField('pin', { definition })).toBe(true);
    expect(isSecretField('apiToken')).toBe(true);
    expect(isSecretField('baseUrl')).toBe(false);
  });
});

describe('apps binding an installation', () => {
  const APPS = [
    { id: 'by-id', name: { en: 'By id' }, integrations: { x500bund: {} } },
    {
      id: 'by-definition',
      name: { en: 'By definition' },
      integrations: { 'com.intrafind/ldap-directory': {} }
    },
    { id: 'by-type', name: { en: 'By type' }, integrations: { 'type:people-directory': {} } },
    { id: 'other', name: { en: 'Other' }, integrations: { govdata: {} } },
    { id: 'none', name: { en: 'None' } }
  ];

  test('by installation id, definition id or type key', () => {
    const bound = appsBindingInstallation(
      APPS,
      { id: 'x500bund', definition: 'com.intrafind/ldap-directory', type: 'people-directory' },
      'en'
    );
    expect(bound).toEqual([
      { id: 'by-id', name: 'By id', via: 'installation' },
      { id: 'by-definition', name: 'By definition', via: 'definition' },
      { id: 'by-type', name: 'By type', via: 'type' }
    ]);
    expect(appsBindingInstallation(APPS, { id: 'lonely', definition: 'x/y' }, 'en')).toEqual([]);
  });
});

describe('the save body of an editor', () => {
  const instance = {
    id: 'ifinder',
    definition: 'com.intrafind/ifinder',
    labelLocalized: { en: 'iFinder', de: 'iFinder (DE)' },
    description: { en: 'Search', de: 'Suche' },
    enabled: false,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: ['discover'], overrides: {} }
  };

  test('keeps what the editor does not change and merges the edited language', () => {
    const body = buildInstallationPayload(instance, {
      values: {
        baseUrl: 'https://ifinder.example.com',
        privateKeyRef: '',
        allowedSearchProfiles: []
      },
      lang: 'en',
      label: 'Our iFinder'
    });
    expect(body).toEqual({
      id: 'ifinder',
      definition: 'com.intrafind/ifinder',
      label: { en: 'Our iFinder', de: 'iFinder (DE)' },
      description: { en: 'Search', de: 'Suche' },
      enabled: false,
      values: { baseUrl: 'https://ifinder.example.com' },
      auth: { mode: 'none' },
      actions: { enabled: ['*'], disabled: ['discover'], overrides: {} }
    });
    // Groups are granted on the group page (#3093): the body carries none.
    expect(body).not.toHaveProperty('allowedGroups');
    expect(mergedLabel({ en: 'A', de: 'B' }, 'en', '')).toEqual({ de: 'B' });
    expect(mergedLabel(null, 'en', '')).toBeUndefined();
  });
});

describe('groupsGranting', () => {
  const groups = {
    admins: { inherits: ['users'], permissions: { integrations: [] } },
    users: { permissions: { integrations: ['*'] } },
    people: { permissions: { integrations: ['type:people-directory'] } },
    ldap: { permissions: { integrations: ['com.intrafind/ldap-directory'] } },
    one: { permissions: { integrations: ['x500bund'] } },
    none: { permissions: {} }
  };

  test('lists the groups whose own grants cover the installation', () => {
    const directory = {
      id: 'x500bund',
      definition: 'com.intrafind/ldap-directory',
      type: 'people-directory'
    };
    expect(groupsGranting(directory, groups)).toEqual(['ldap', 'one', 'people', 'users']);
    expect(groupsGranting({ id: 'jira', definition: 'com.intrafind/jira' }, groups)).toEqual([
      'users'
    ]);
    expect(groupsGranting(directory, null)).toEqual([]);
  });
});
