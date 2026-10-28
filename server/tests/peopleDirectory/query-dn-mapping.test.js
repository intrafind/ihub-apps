// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * People directory search (#3026): the pure parts — query construction, the
 * result and time limits, the DN scope check of `get_person`, and the mapping
 * of directory entries onto `Person`.
 *
 * The fixtures are made-up people. The x500.bund.de entry has the attribute
 * names, formats and DN structure of a real entry, with invented values.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolArgumentError,
  buildSearchFilter,
  cleanStructuredValue,
  resolveResultLimit,
  timeLimitSeconds,
  tokenizeQuery
} from '../../services/peopleDirectory/query.js';
import {
  dnComponent,
  escapeDnValue,
  formatRdn,
  isDnWithin,
  parseDn
} from '../../services/peopleDirectory/dn.js';
import { mapEntryToPerson, requestedAttributes } from '../../services/peopleDirectory/mapping.js';
import { PERSON_FIELDS, resolveMapping } from '../../services/peopleDirectory/presets.js';

describe('query construction', () => {
  it('escapes every RFC 4515 special character in a search word', () => {
    const filter = buildSearchFilter({
      personFilter: '(objectClass=person)',
      searchAttributes: ['cn', 'sn'],
      tokens: ['a*b(c)d\\e\u0000f']
    });
    assert.equal(
      filter,
      '(&(objectClass=person)(|(cn=*a\\2ab\\28c\\29d\\5ce\\00f*)(sn=*a\\2ab\\28c\\29d\\5ce\\00f*)))'
    );
  });

  it('builds one OR-block per word and prefix blocks for structured fields', () => {
    const filter = buildSearchFilter({
      personFilter: '(objectClass=ivbbPerson)',
      searchAttributes: ['cn', 'sn', 'givenName', 'mail'],
      tokens: ['greiner', 'ralf'],
      structured: [
        { attributes: ['sn'], value: 'greiner' },
        { attributes: ['ou', 'departmentNumber'], value: 'IT' }
      ]
    });
    assert.equal(
      filter,
      '(&(objectClass=ivbbPerson)' +
        '(|(cn=*greiner*)(sn=*greiner*)(givenName=*greiner*)(mail=*greiner*))' +
        '(|(cn=*ralf*)(sn=*ralf*)(givenName=*ralf*)(mail=*ralf*))' +
        '(sn=greiner*)(|(ou=IT*)(departmentNumber=IT*)))'
    );
  });

  it('splits free text into words and drops one-letter words', () => {
    assert.deepEqual(tokenizeQuery('Mustermann, Erika  M'), {
      tokens: ['Mustermann', 'Erika'],
      dropped: ['M']
    });
    assert.deepEqual(tokenizeQuery('erika.mustermann@example.org').tokens, [
      'erika.mustermann@example.org'
    ]);
  });

  it('strips wildcards the model adds and refuses a wildcard-only or too-short query', () => {
    assert.deepEqual(tokenizeQuery('*Muster*').tokens, ['Muster']);
    assert.throws(() => tokenizeQuery('*'), ToolArgumentError);
    assert.throws(() => tokenizeQuery('* ** a'), ToolArgumentError);
    assert.throws(() => tokenizeQuery(''), ToolArgumentError);
    assert.throws(() => tokenizeQuery(undefined), ToolArgumentError);
    assert.throws(() => tokenizeQuery('a b c d e f g h'.replace(/ /g, 'x ')), ToolArgumentError);
  });

  it('checks structured values', () => {
    assert.equal(cleanStructuredValue('lastName', undefined), null);
    assert.equal(cleanStructuredValue('lastName', 'Muster*'), 'Muster');
    assert.throws(() => cleanStructuredValue('lastName', 'M'), ToolArgumentError);
    assert.throws(() => cleanStructuredValue('lastName', 42), ToolArgumentError);
  });
});

describe('result limit', () => {
  it('clamps a request above the directory limit and asks for one more entry', () => {
    assert.deepEqual(resolveResultLimit(50, 25), { effectiveMaxResults: 25, sizeLimit: 26 });
    assert.deepEqual(resolveResultLimit(5, 25), { effectiveMaxResults: 5, sizeLimit: 6 });
    assert.deepEqual(resolveResultLimit(undefined, 25), { effectiveMaxResults: 25, sizeLimit: 26 });
  });

  it('rejects 0, negative, fractional and non-numeric values, so sizeLimit 0 never reaches ldapts', () => {
    for (const bad of [0, -1, 2.5, '10', Number.NaN, Infinity, true]) {
      assert.throws(() => resolveResultLimit(bad, 25), ToolArgumentError, String(bad));
    }
  });
});

describe('time limit', () => {
  it('sends the timeout in whole seconds, rounded up', () => {
    assert.equal(timeLimitSeconds(8000), 8);
    assert.equal(timeLimitSeconds(1500), 2);
    assert.equal(timeLimitSeconds(1000), 1);
  });
});

describe('DN scope check', () => {
  const base = 'o=Bund,c=DE';

  it('accepts a DN inside the base', () => {
    assert.equal(isDnWithin('cn=Mustermann Erika,l=Karlsruhe,ou=MRI,o=Bund,c=DE', base), true);
  });

  it('rejects the base itself, a sibling naming context, a look-alike suffix and malformed DNs', () => {
    assert.equal(isDnWithin('o=Bund,c=DE', base), false);
    assert.equal(isDnWithin('cn=CA,o=PKI-1-VERWALTUNG,c=DE', base), false);
    assert.equal(isDnWithin('cn=x,o=Bund,c=DE.evil', base), false);
    assert.equal(isDnWithin('not a dn', base), false);
    assert.equal(isDnWithin('cn=x,o=Bund,c=DE,', base), false);
    assert.equal(isDnWithin('cn=x;o=Bund,c=DE', base), false);
    assert.equal(isDnWithin('cn=x,o=Bund,c=DE', 'not a dn'), false);
    assert.equal(isDnWithin(42, base), false);
  });

  it('does not treat an escaped comma as a separator', () => {
    assert.equal(isDnWithin('cn=x\\,ou=people,o=firma', 'ou=people,o=firma'), false);
    assert.equal(isDnWithin('cn=x\\2cou=people,o=firma', 'ou=people,o=firma'), false);
    assert.equal(isDnWithin('cn=x\\,y,ou=people,o=firma', 'ou=people,o=firma'), true);
  });

  it('compares multi-valued RDNs as sets, in either order', () => {
    assert.equal(isDnWithin('cn=x,ou=a+l=b,o=f', 'l=b+ou=a,o=f'), true);
    assert.equal(isDnWithin('cn=x,ou=a+l=b,o=f', 'ou=a,o=f'), false);
  });

  it('normalises OID and alias attribute types, case and whitespace', () => {
    assert.equal(isDnWithin('cn=x,2.5.4.10=Bund,c=DE', base), true);
    assert.equal(isDnWithin('cn=x,organizationName=Bund,countryName=DE', base), true);
    assert.equal(isDnWithin('CN=x, O = bund ,  C=de', base), true);
    assert.equal(isDnWithin('cn=x,ou=Rechts   Abteilung,o=f', 'ou=rechts abteilung,o=F'), true);
  });

  it('reads DN components and formats RDNs with escaping', () => {
    assert.equal(
      dnComponent('cn=Mustermann Erika,l=Karlsruhe,ou=MRI,o=Bund,c=DE', 'l'),
      'Karlsruhe'
    );
    assert.equal(dnComponent('cn=M,ou=MRI,o=Bund,c=DE', 'organizationalUnitName'), 'MRI');
    assert.equal(dnComponent('cn=M,o=Bund', 'l'), null);
    assert.equal(escapeDnValue('a,b+c'), 'a\\,b\\+c');
    assert.equal(formatRdn(parseDn('ou=a\\,b,o=f')[0]), 'ou=a\\,b');
  });
});

/** The x500.bund.de entry of the concept, with made-up values. */
const IVBB_ENTRY = {
  dn: 'cn=Mustermann Erika,l=Karlsruhe,ou=MRI,o=Bund,c=DE',
  cn: 'Mustermann Erika',
  sn: 'Mustermann',
  givenName: 'Erika',
  displayName: 'Mustermann, Erika',
  title: 'Dr.',
  role: 'Vertreterin des Präsidenten',
  vocation: 'Frau',
  gouvernmentOrganizationalUnit: 'Leitung',
  company: 'MRI',
  telephoneNumber: '0721 0000 - 300',
  facsimileTelephoneNumber: '0721 0000 - 111',
  mail: 'erika.mustermann@example.org'
};

describe('ivbb mapping', () => {
  it('maps the x500.bund.de entry onto the Person of the concept', () => {
    const { mapping } = resolveMapping('ivbb');
    const { person } = mapEntryToPerson(IVBB_ENTRY, { directoryId: 'x500bund', mapping });
    assert.deepEqual(person, {
      directory: 'x500bund',
      personId: 'cn=Mustermann Erika,l=Karlsruhe,ou=MRI,o=Bund,c=DE',
      name: 'Erika Mustermann',
      firstName: 'Erika',
      lastName: 'Mustermann',
      salutation: 'Frau',
      academicTitle: 'Dr.',
      jobTitle: 'Vertreterin des Präsidenten',
      department: 'Leitung',
      organization: 'MRI',
      location: 'Karlsruhe',
      email: 'erika.mustermann@example.org',
      phone: '0721 0000 - 300',
      fax: '0721 0000 - 111',
      mobile: null,
      managerId: null
    });
    assert.deepEqual(Object.keys(person), PERSON_FIELDS);
  });

  it('reads attributes whatever case the server returns, and falls back to the DN', () => {
    const { mapping } = resolveMapping('ivbb');
    const { person, usedSources } = mapEntryToPerson(
      {
        dn: 'cn=Mustermann Erika,ou=MRI,o=Bund,c=DE',
        SN: 'Mustermann',
        CN: 'Mustermann Erika',
        GOUVERNMENTORGANIZATIONALUNIT: 'Leitung'
      },
      { directoryId: 'x500bund', mapping }
    );
    // No givenName: "givenName sn" cannot be composed, so cn is used.
    assert.equal(person.name, 'Mustermann Erika');
    assert.equal(person.department, 'Leitung');
    assert.equal(person.organization, 'MRI');
    assert.equal(usedSources.organization, 'dn:ou');
    assert.equal(person.location, null);
  });

  it('requests only mapped attributes, never "*"', () => {
    const attributes = requestedAttributes(resolveMapping('ivbb').mapping);
    assert.ok(!attributes.includes('*'));
    assert.ok(attributes.includes('role'));
    assert.ok(attributes.includes('gouvernmentOrganizationalUnit'));
    assert.ok(!attributes.some(name => /password|certificate|photo/i.test(name)));
    // Only DN sources: ask for no attributes at all, since an empty list means all.
    assert.deepEqual(requestedAttributes({ name: ['dn:cn'], organization: ['dn:ou'] }), ['1.1']);
  });
});

describe('preset mappings', () => {
  it('maps an Active Directory user with a manager', () => {
    const { mapping } = resolveMapping('activeDirectory');
    const { person } = mapEntryToPerson(
      {
        dn: 'CN=Max Beispiel,OU=Staff,DC=corp,DC=example',
        displayName: 'Max Beispiel',
        givenName: 'Max',
        sn: 'Beispiel',
        title: 'Head of IT',
        department: 'IT',
        company: 'Example AG',
        physicalDeliveryOfficeName: 'Munich',
        mail: 'max.beispiel@example.com',
        telephoneNumber: '+49 89 0000-1',
        mobile: '+49 170 0000000',
        manager: 'CN=Erika Muster,OU=Staff,DC=corp,DC=example'
      },
      { directoryId: 'corp', mapping }
    );
    assert.equal(person.name, 'Max Beispiel');
    assert.equal(person.jobTitle, 'Head of IT');
    assert.equal(person.academicTitle, null);
    assert.equal(person.department, 'IT');
    assert.equal(person.organization, 'Example AG');
    assert.equal(person.location, 'Munich');
    assert.equal(person.mobile, '+49 170 0000000');
    assert.equal(person.managerId, 'CN=Erika Muster,OU=Staff,DC=corp,DC=example');
  });

  it('maps an OpenLDAP inetOrgPerson', () => {
    const { mapping } = resolveMapping('openldap');
    const { person } = mapEntryToPerson(
      {
        dn: 'uid=jdoe,ou=people,dc=example,dc=org',
        cn: 'Jane Doe',
        givenName: 'Jane',
        sn: 'Doe',
        title: 'Engineer',
        ou: ['Research', 'Lab'],
        o: 'Example Org',
        l: 'Berlin',
        mail: 'jane.doe@example.org'
      },
      { directoryId: 'ldap', mapping }
    );
    // No displayName: composed from givenName and sn.
    assert.equal(person.name, 'Jane Doe');
    assert.equal(person.jobTitle, 'Engineer');
    assert.equal(person.department, 'Research');
    assert.equal(person.organization, 'Example Org');
    assert.equal(person.location, 'Berlin');
    assert.equal(person.managerId, null);
  });

  it('lets a directory override a field', () => {
    const { mapping, sources } = resolveMapping('ivbb', { jobTitle: 'title', mobile: ['mobile'] });
    assert.deepEqual(mapping.jobTitle, ['title']);
    assert.equal(sources.jobTitle, 'explicit');
    assert.equal(sources.phone, 'preset');
    assert.equal(sources.managerId, 'unset');
  });
});
