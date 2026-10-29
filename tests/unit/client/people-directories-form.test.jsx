// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The form logic behind Admin → Integrations → People directories
 * (client/src/features/admin/utils/peopleDirectories.js):
 *
 *   - a stored directory survives the round trip through the editor unchanged;
 *   - empty optional fields are dropped (the schema rejects empty strings, and an
 *     omitted field takes the sign-in provider's or the preset's value);
 *   - "Use for people search" prefills a new entry that reuses the provider;
 *   - validation, the mapping of server issues onto inputs, and the helpers of
 *     the list page.
 */
import {
  createDirectoryForm,
  describeSaveError,
  directoryToForm,
  effectivePresetId,
  formToDirectory,
  inputIdForField,
  parseList,
  parseMappingCandidates,
  shouldOfferPeopleSearchApp,
  splitSaveIssues,
  suggestDirectoryId,
  toolIdsFor,
  transportOf,
  validateDirectoryForm,
  withDirectory,
  withDirectoryEnabled,
  withoutDirectory
} from '../../../client/src/features/admin/utils/peopleDirectories';

/** The shipped x500.bund.de entry (server/defaults/config/peopleDirectories.json). */
const X500 = {
  id: 'x500bund',
  enabled: false,
  type: 'ldap',
  url: 'ldaps://x500.bund.de:636',
  baseDn: 'o=Bund,c=DE',
  preset: 'ivbb',
  bind: { mode: 'anonymous' },
  units: true,
  tlsCa: ['pca-1-verwaltung-23'],
  maxResults: 25,
  timeoutMs: 8000,
  groups: ['authenticated'],
  dataFlow: 'external',
  name: { en: 'Federal directory (IVBB)', de: 'Verzeichnisdienst des Bundes (IVBB)' },
  description: { en: 'Public directory of German federal authorities.', de: 'Bundesbehörden.' }
};

describe('directory ↔ form', () => {
  test('a stored directory comes back unchanged', () => {
    const roundTrip = formToDirectory(directoryToForm(X500));
    expect(roundTrip).toEqual(X500);
  });

  test('keeps overrides, service bind, mapping, tlsOptions and the LDAP browser', () => {
    const corp = {
      id: 'corp',
      enabled: true,
      type: 'ldap',
      authProvider: 'corp-ad',
      starttls: true,
      tlsOptions: { minVersion: 'TLSv1.2' },
      bind: { mode: 'service', dn: 'cn=svc,dc=corp', passwordRef: 'ldap-svc' },
      searchBase: 'ou=people,dc=corp',
      personFilter: '(objectClass=user)',
      searchAttributes: ['cn', 'mail'],
      attributeMapping: { jobTitle: ['role', 'title'], name: ['givenName sn'] },
      allowPlaintext: true,
      allowedHosts: ['dc.corp.local'],
      concurrency: 3,
      requestDelayMs: 100,
      groups: ['*'],
      dataFlow: 'internal',
      // Not edited on the page; a save must not drop it.
      browse: { enabled: true, groups: ['admins'], denyAttributes: ['info'] }
    };
    expect(formToDirectory(directoryToForm(corp))).toEqual(corp);
  });

  test('drops empty optional fields and empty languages', () => {
    const form = directoryToForm({ id: 'plain', url: 'ldaps://ldap.example.org', baseDn: 'dc=x' });
    form.searchBase = '   ';
    form.attributeMapping = { jobTitle: ' ' };
    form.name = { en: 'Plain', de: '' };
    form.maxResults = '';
    expect(formToDirectory(form)).toEqual({
      id: 'plain',
      enabled: true,
      type: 'ldap',
      url: 'ldaps://ldap.example.org',
      baseDn: 'dc=x',
      groups: ['authenticated'],
      dataFlow: 'internal',
      name: { en: 'Plain' }
    });
  });

  test('a direct connection drops the provider; "default" bind is omitted', () => {
    const form = directoryToForm({ id: 'corp', authProvider: 'corp-ad' });
    expect(form.sourceMode).toBe('provider');
    expect(form.bindMode).toBe('default');
    form.sourceMode = 'direct';
    form.url = 'ldaps://ldap.example.org';
    form.baseDn = 'dc=example,dc=org';
    const directory = formToDirectory(form);
    expect(directory.authProvider).toBeUndefined();
    expect(directory.bind).toBeUndefined();
  });

  test('numbers are sent as numbers, mapping candidates keep joined attributes', () => {
    const form = directoryToForm({ id: 'x' });
    form.maxResults = '25';
    form.attributeMapping = { name: 'givenName   sn, cn', location: 'dn:l\nl' };
    const directory = formToDirectory(form);
    expect(directory.maxResults).toBe(25);
    expect(directory.attributeMapping).toEqual({
      name: ['givenName sn', 'cn'],
      location: ['dn:l', 'l']
    });
  });
});

describe('createDirectoryForm', () => {
  test('"Use for people search" reuses the provider and suggests a free id', () => {
    const form = createDirectoryForm({
      authProvider: 'corp-ad',
      name: 'Corporate AD',
      existingIds: ['corp-ad']
    });
    expect(form).toMatchObject({
      id: 'corp-ad-2',
      enabled: true,
      sourceMode: 'provider',
      authProvider: 'corp-ad',
      bindMode: 'default',
      groups: ['authenticated'],
      dataFlow: 'internal',
      name: { en: 'Corporate AD', de: 'Corporate AD' }
    });
    expect(formToDirectory(form)).toMatchObject({ id: 'corp-ad-2', authProvider: 'corp-ad' });
  });

  test('a blank entry connects directly and has no id yet', () => {
    const form = createDirectoryForm();
    expect(form.sourceMode).toBe('direct');
    expect(form.id).toBe('');
    expect(form.name).toEqual({ en: '', de: '' });
  });
});

describe('suggestDirectoryId', () => {
  test.each([
    ['Corp_AD', [], 'corp-ad'],
    ['Ämter Süd', [], 'amter-sud'],
    ['-x', [], 'directory'],
    ['peopleDirectories', [], 'directory'],
    ['a'.repeat(40), [], 'a'.repeat(32)],
    ['corp', ['corp', 'corp-2'], 'corp-3']
  ])('%s → %s', (base, taken, expected) => {
    const id = suggestDirectoryId(base, taken);
    expect(id).toBe(expected);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,31}$/);
  });
});

describe('validateDirectoryForm', () => {
  const fieldsOf = errors => errors.map(error => error.field);

  test('a new direct entry needs id, URL and base DN', () => {
    expect(fieldsOf(validateDirectoryForm(createDirectoryForm(), { isNew: true }))).toEqual([
      'id',
      'url',
      'baseDn'
    ]);
  });

  test('a provider entry needs the provider, a service bind needs DN and credential', () => {
    const form = createDirectoryForm({ authProvider: 'corp-ad' });
    form.authProvider = '';
    form.bindMode = 'service';
    expect(fieldsOf(validateDirectoryForm(form, { isNew: true }))).toEqual([
      'authProvider',
      'bind.dn',
      'bind.passwordRef'
    ]);
  });

  test('rejects bad ids, taken ids, URLs with a path, filters and out-of-range limits', () => {
    const form = directoryToForm({ ...X500, id: 'X500_Bund' });
    expect(validateDirectoryForm(form, { isNew: true })[0].message.key).toBe(
      'admin.peopleDirectories.errors.idPattern'
    );
    form.id = 'corp';
    expect(validateDirectoryForm(form, { isNew: true, otherIds: ['corp'] })[0].message).toEqual({
      key: 'admin.peopleDirectories.errors.idTaken',
      defaultValue: 'Another directory uses "{{id}}".',
      values: { id: 'corp' }
    });
    // `new` is the editor's create route; the others are tool prefixes routed elsewhere.
    for (const id of [
      'new',
      'app',
      'workflow',
      'source',
      'knowledge',
      'a2a',
      'peopledirectories'
    ]) {
      form.id = id;
      expect(validateDirectoryForm(form, { isNew: true })[0].message.key).toBe(
        'admin.peopleDirectories.errors.idReserved'
      );
    }
    form.id = 'new-one';
    form.url = 'ldaps://x500.bund.de:636/o=Bund';
    form.personFilter = 'objectClass=person';
    form.maxResults = '51';
    form.timeoutMs = '2.5';
    expect(fieldsOf(validateDirectoryForm(form, { isNew: true }))).toEqual([
      'url',
      'personFilter',
      'maxResults',
      'timeoutMs'
    ]);
    expect(validateDirectoryForm(form, { limits: { maxResults: 100 } }).map(e => e.field)).toEqual([
      'url',
      'personFilter',
      'timeoutMs'
    ]);
  });

  test('the id of a saved directory is not checked again', () => {
    expect(validateDirectoryForm(directoryToForm(X500), { otherIds: ['x500bund'] })).toEqual([]);
  });
});

describe('server issues → inputs', () => {
  test('issues of the edited directory go to its fields, others are listed apart', () => {
    const { fields, other } = splitSaveIssues(
      [
        { path: ['directories', 1, 'url'], message: 'Use ldaps://host:636' },
        { path: ['directories', 1, 'attributeMapping', 'jobTitle', 0], message: 'Bad' },
        { path: ['directories', 0, 'id'], message: 'Duplicate' },
        { path: [], message: 'Broken file' }
      ],
      1
    );
    expect(fields).toEqual([
      { field: 'url', message: 'Use ldaps://host:636' },
      { field: 'attributeMapping.jobTitle', message: 'Bad' }
    ]);
    expect(other).toEqual(['directories.0.id: Duplicate', 'Broken file']);
  });

  test.each([
    ['url', 'pd-url'],
    ['bind.dn', 'pd-bind-dn'],
    ['bind', 'pd-bind-mode-anonymous'],
    ['dataFlow', 'pd-data-flow-internal'],
    ['attributeMapping.jobTitle', 'pd-mapping-jobTitle'],
    ['name.de', 'pd-name.de'],
    ['tlsOptions', null]
  ])('%s → %s', (field, id) => {
    expect(inputIdForField(field)).toBe(id);
  });

  test('describeSaveError names the schema issues of a 400', () => {
    const err = {
      response: {
        status: 400,
        data: {
          error: 'Invalid people directory configuration',
          details: [{ path: ['directories', 0, 'url'], message: 'Use ldaps://host:636' }]
        }
      }
    };
    expect(describeSaveError(err)).toBe(
      'Invalid people directory configuration (directories.0.url: Use ldaps://host:636)'
    );
    expect(describeSaveError({ response: { status: 409, data: { error: 'Clash' } } })).toBe(
      'Clash'
    );
    expect(describeSaveError(new Error('Network Error'))).toBe('Network Error');
  });
});

describe('list helpers', () => {
  const list = [X500, { id: 'corp', enabled: true }];

  test('put in, take out and switch one directory without touching the others', () => {
    expect(withDirectory(list, { id: 'new' }, null).map(d => d.id)).toEqual([
      'x500bund',
      'corp',
      'new'
    ]);
    expect(withDirectory(list, { id: 'corp', enabled: false }, 'corp')[1]).toEqual({
      id: 'corp',
      enabled: false
    });
    expect(withoutDirectory(list, 'corp')).toEqual([X500]);
    const switched = withDirectoryEnabled(list, 'x500bund', true);
    expect(switched[0]).toEqual({ ...X500, enabled: true });
    expect(switched[1]).toBe(list[1]);
  });

  test('offers the People search app only when a directory was switched on and the app is off', () => {
    const off = { exists: true, enabled: false };
    expect(shouldOfferPeopleSearchApp(off, { wasEnabled: false, isEnabled: true })).toBe(true);
    expect(shouldOfferPeopleSearchApp(off, { wasEnabled: true, isEnabled: true })).toBe(false);
    expect(shouldOfferPeopleSearchApp(off, { wasEnabled: false, isEnabled: false })).toBe(false);
    expect(
      shouldOfferPeopleSearchApp(
        { exists: true, enabled: true },
        { wasEnabled: false, isEnabled: true }
      )
    ).toBe(false);
    expect(
      shouldOfferPeopleSearchApp({ exists: false }, { wasEnabled: false, isEnabled: true })
    ).toBe(false);
  });
});

describe('transport and preset', () => {
  const provider = {
    name: 'corp-ad',
    url: 'ldap://dc.corp:389',
    starttls: true,
    preset: 'activeDirectory'
  };

  test('reads URL and StartTLS from the reused provider unless overridden', () => {
    const form = createDirectoryForm({ authProvider: 'corp-ad' });
    expect(transportOf(form, provider)).toBe('starttls');
    form.starttls = 'off';
    expect(transportOf(form, provider)).toBe('plaintext');
    form.url = 'ldaps://dc.corp:636';
    expect(transportOf(form, provider)).toBe('ldaps');
    expect(transportOf(createDirectoryForm(), undefined)).toBe('unknown');
  });

  test('a direct connection ignores the provider', () => {
    const form = directoryToForm({ id: 'x', url: 'ldap://ldap.example.org' });
    expect(transportOf(form, provider)).toBe('plaintext');
    expect(effectivePresetId(form, provider)).toBe('openldap');
  });

  test('preset: own, else the provider, else OpenLDAP', () => {
    const form = createDirectoryForm({ authProvider: 'corp-ad' });
    expect(effectivePresetId(form, provider)).toBe('activeDirectory');
    form.preset = 'ivbb';
    expect(effectivePresetId(form, provider)).toBe('ivbb');
  });

  test('tool ids follow <id>__<action>', () => {
    expect(toolIdsFor('x500bund', true)).toEqual([
      'x500bund__search_people',
      'x500bund__get_person',
      'x500bund__list_units'
    ]);
    expect(toolIdsFor('', false)).toEqual(['<id>__search_people', '<id>__get_person']);
  });
});

describe('text helpers', () => {
  test('parseList splits on commas and lines, without blanks or duplicates', () => {
    expect(parseList('a, b\n\nc,a , ')).toEqual(['a', 'b', 'c']);
    expect(parseMappingCandidates('givenName  sn,\ncn')).toEqual(['givenName sn', 'cn']);
  });
});

describe('trusted certificates', () => {
  test('are edited one name per line and checked against the store name pattern', () => {
    const form = directoryToForm(X500);
    expect(form.tlsCa).toBe('pca-1-verwaltung-23');
    form.tlsCa = 'pca-1-verwaltung-23\ncorp-root\n';
    expect(formToDirectory(form).tlsCa).toEqual(['pca-1-verwaltung-23', 'corp-root']);
    form.tlsCa = 'corp-root.pem';
    expect(validateDirectoryForm(form)).toEqual([
      {
        field: 'tlsCa',
        message: expect.objectContaining({
          key: 'admin.peopleDirectories.errors.tlsCaPattern',
          values: { name: 'corp-root.pem' }
        })
      }
    ]);
  });
});
