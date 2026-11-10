// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every text the end-user frontend asks for with a literal key, `t('some.key', 'Default')`, must
 * exist in the built-in locales, English and German. The server drops an override for a key the
 * built-in file does not know (configCache.mergeLocaleData), so a key that is only in the code
 * cannot be overridden by an admin and has no German text.
 *
 * Not covered: the admin area (client/src/features/admin), the login gate (its own bundled
 * table), keys under `admin.` that shared components borrow, and keys built at run time.
 */
import fs from 'fs';
import path from 'path';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const SRC = path.resolve('client/src');
const SKIPPED_DIRS = [path.join(SRC, 'features', 'admin'), path.join(SRC, 'auth-gate')];

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.includes(full)) sourceFiles(full, out);
    } else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// `t('a.b')`, `t("a.b", …)` and `i18n.t('a.b')`; keys without a dot are not translation keys
// of the client (the login gate has its own table).
const CALL = /(?<![\w.$])(?:i18n\.)?t\(\s*(['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g;

function literalKeys(file) {
  // Comments (JSDoc examples) are not calls.
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  return [...text.matchAll(CALL)].map(match => ({
    key: match[2],
    line: text.slice(0, match.index).split('\n').length
  }));
}

function known(locale, key) {
  const lookup = k =>
    k
      .split('.')
      .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), locale);
  return (
    lookup(key) !== undefined ||
    lookup(`${key}_one`) !== undefined ||
    lookup(`${key}_other`) !== undefined
  );
}

describe('translation keys used by the end-user frontend', () => {
  const used = sourceFiles(SRC).flatMap(file =>
    literalKeys(file)
      .filter(({ key }) => !key.startsWith('admin.'))
      .map(({ key, line }) => ({ key, where: `${path.relative(SRC, file)}:${line}` }))
  );

  it('are found in the source', () => {
    expect(used.length).toBeGreaterThan(500);
  });

  it.each([
    ['English', en],
    ['German', de]
  ])('exist in the built-in %s translations', (_name, locale) => {
    const missing = used.filter(({ key }) => !known(locale, key)).map(u => `${u.key} (${u.where})`);
    expect([...new Set(missing)]).toEqual([]);
  });
});
