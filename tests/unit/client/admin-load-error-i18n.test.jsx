// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import fs from 'fs';
import path from 'path';

/**
 * The load-error panel builds its title from a template and a resource label
 * ("Couldn't load {{resource}}"). Every label a page passes must exist in both
 * languages, or German shows "CORS Configuration konnte nicht geladen werden"
 * (R8); and the German template must not put the label in subject position,
 * where an article-led plural label reads "die … konnte" (R4).
 */

const ROOT = path.resolve(__dirname, '../../..');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/i18n/en.json'), 'utf8'));
const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/i18n/de.json'), 'utf8'));

const lookup = (dict, key) =>
  key
    .split('.')
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);

/** All `.js`/`.jsx` files under `dir`. */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.jsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The i18n keys passed as a load-error resource label anywhere in the client. */
function resourceLabelKeys() {
  const keys = new Set();
  const pattern = /resourceLabel(?:=\{|:\s*)t\(\s*'([^']+)'/g;
  for (const file of sourceFiles(path.join(ROOT, 'client/src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) keys.add(match[1]);
  }
  return [...keys].sort();
}

describe('load-error resource labels', () => {
  const keys = resourceLabelKeys();

  it('finds the labels the admin pages pass', () => {
    expect(keys).toEqual(expect.arrayContaining(['admin.auth.resource', 'admin.cors.title']));
  });

  it.each(keys)('%s exists in en and de', key => {
    expect(typeof lookup(en, key)).toBe('string');
    expect(typeof lookup(de, key)).toBe('string');
  });

  it.each(keys)('%s has no leading article in German', key => {
    expect(lookup(de, key)).not.toMatch(/^(der|die|das|den|dem|des|diese[nrms]?)\s/i);
  });

  it('German titles do not start with the label', () => {
    for (const key of ['title', 'forbiddenTitle', 'notFoundTitle']) {
      expect(lookup(de, `admin.load.${key}`)).not.toMatch(/^\{\{resource\}\}/);
    }
  });
});

describe('keys used without a translation entry (R8)', () => {
  it.each([
    'admin.logging.currentLevel',
    'admin.mcp.gateway.discoveryLabel',
    'admin.mcp.gateway.endpointLabel',
    'admin.mcp.gateway.transportStateless',
    'admin.overview.apps.enabledCount',
    'admin.ui.title',
    'admin.ui.description',
    'common.note'
  ])('%s exists in en and de', key => {
    expect(typeof lookup(en, key)).toBe('string');
    expect(typeof lookup(de, key)).toBe('string');
  });
});
