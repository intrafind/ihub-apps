// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every string of the people directory admin pages exists in English and
 * German, with the same placeholders. The client falls back to the English
 * default of a missing key without a word, so nothing else would notice.
 *
 * Keys are read from the source files, so a new string fails here until it is
 * translated. Keys built at runtime (person fields, presets, test steps) are
 * listed explicitly.
 */
import fs from 'fs';
import path from 'path';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const ROOT = path.resolve(__dirname, '../../..');
const SOURCES = [
  'client/src/features/admin/components/people-directories',
  'client/src/features/admin/pages/AdminPeopleDirectoriesPage.jsx',
  'client/src/features/admin/pages/AdminPeopleDirectoryEditPage.jsx',
  'client/src/features/admin/utils/peopleDirectories.js',
  'client/src/features/admin/pages/AdminIntegrationsPage.jsx',
  'client/src/features/admin/components/platform-form/LdapProvidersSection.jsx'
];
const PREFIXES = [
  'admin.peopleDirectories.',
  'admin.integrations.cards.peopleDirectories.',
  'admin.integrations.categories.directories',
  'admin.auth.ldap.useForPeopleSearch'
];
const DYNAMIC_KEYS = [
  ...[
    'name',
    'firstName',
    'lastName',
    'salutation',
    'academicTitle',
    'jobTitle',
    'department',
    'organization',
    'location',
    'email',
    'phone',
    'fax',
    'mobile',
    'managerId'
  ].map(field => `admin.peopleDirectories.fields.${field}`),
  ...['openldap', 'activeDirectory', 'ivbb'].map(id => `admin.peopleDirectories.presets.${id}`),
  ...['configuration', 'network', 'connect', 'starttls', 'bind', 'search', 'mapping'].map(
    id => `admin.peopleDirectories.test.steps.${id}`
  )
];
// Strings that are the same word in both languages.
const SAME_IN_BOTH = new Set([
  'admin.peopleDirectories.certificates.ca',
  'admin.peopleDirectories.fields.fax',
  'admin.peopleDirectories.fields.name',
  'admin.peopleDirectories.form.id',
  'admin.peopleDirectories.model.name',
  'admin.peopleDirectories.network.transport',
  'admin.peopleDirectories.presets.activeDirectory',
  'admin.peopleDirectories.source.starttls',
  'admin.peopleDirectories.source.url',
  'admin.peopleDirectories.test.steps.starttls',
  'admin.peopleDirectories.test.title',
  'admin.peopleDirectories.limits.timeoutMs'
]);

function sourceFiles(entry) {
  const full = path.join(ROOT, entry);
  if (fs.statSync(full).isFile()) return [full];
  return fs
    .readdirSync(full)
    .filter(name => /\.(js|jsx)$/.test(name))
    .map(name => path.join(full, name));
}

function usedKeys() {
  const keys = new Set(DYNAMIC_KEYS);
  for (const file of SOURCES.flatMap(sourceFiles)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/['"`]((?:admin|common)\.[A-Za-z0-9_.]+)['"`]/g)) {
      const key = match[1];
      if (PREFIXES.some(prefix => key.startsWith(prefix)) && !key.endsWith('.')) keys.add(key);
    }
  }
  return [...keys].sort();
}

const lookup = (messages, key) => key.split('.').reduce((node, part) => node?.[part], messages);
const placeholders = text => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();

/** The key itself, or its plural forms when the string is counted. */
function variants(messages, key) {
  if (typeof lookup(messages, key) === 'string') return [key];
  return [`${key}_one`, `${key}_other`];
}

function leafKeys(node, prefix) {
  return Object.entries(node || {}).flatMap(([name, value]) =>
    typeof value === 'object' ? leafKeys(value, `${prefix}.${name}`) : [`${prefix}.${name}`]
  );
}

describe('people directory strings', () => {
  const keys = usedKeys();

  test('the scan finds the strings of the pages', () => {
    expect(keys.length).toBeGreaterThan(150);
    expect(keys).toContain('admin.peopleDirectories.network.plaintextWarning');
  });

  it.each(keys)('%s is translated into English and German', key => {
    for (const variant of variants(en, key)) {
      const english = lookup(en, variant);
      const german = lookup(de, variant);
      expect(typeof english).toBe('string');
      expect(english).not.toBe('');
      expect(typeof german).toBe('string');
      expect(german).not.toBe('');
      if (!SAME_IN_BOTH.has(key)) expect(german).not.toBe(english);
      expect(placeholders(german)).toEqual(placeholders(english));
    }
  });

  test('English and German have the same keys under admin.peopleDirectories', () => {
    expect(leafKeys(de.admin.peopleDirectories, 'admin.peopleDirectories').sort()).toEqual(
      leafKeys(en.admin.peopleDirectories, 'admin.peopleDirectories').sort()
    );
  });

  test('every string under admin.peopleDirectories is used', () => {
    const used = new Set(keys.flatMap(key => variants(en, key)));
    const unused = leafKeys(en.admin.peopleDirectories, 'admin.peopleDirectories').filter(
      key => !used.has(key)
    );
    expect(unused).toEqual([]);
  });
});
