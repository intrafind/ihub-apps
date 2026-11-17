// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every text the frontend asks for with a literal key, `t('some.key', 'Default')`, must exist in
 * the built-in locales, English and German. The server drops an override for a key the built-in
 * file does not know (configCache.mergeLocaleData), so a key that is only in the code cannot be
 * overridden by an admin and has no German text.
 *
 * This covers the whole client, the admin area included. The admin area still uses many keys
 * that exist only as inline defaults. Those are counted per file in
 * `translation-keys-baseline.json`, and that file can only shrink:
 *
 * - A file with more missing keys than its baseline count fails: add the new keys to
 *   `shared/i18n/en.json` and `shared/i18n/de.json`. Every key added from now on must be in both.
 * - A file with fewer missing keys than its baseline count also fails: lower its count in the
 *   baseline (or delete the entry at 0), so nobody can add a missing key there later unnoticed.
 *
 * Not covered: the login gate (client/src/auth-gate has its own bundled table) and keys built at
 * run time (`t(\`a.${b}\`)`).
 *
 * Two German checks ride along: every key under `admin` in English also exists in German, and
 * German text addresses the reader formally (Sie, not du).
 */
import fs from 'fs';
import path from 'path';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import baseline from './translation-keys-baseline.json';

const SRC = path.resolve('client/src');
const SKIPPED_DIRS = [path.join(SRC, 'auth-gate')];

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

function lookup(locale, key) {
  return key
    .split('.')
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), locale);
}

function known(locale, key) {
  return (
    lookup(locale, key) !== undefined ||
    lookup(locale, `${key}_one`) !== undefined ||
    lookup(locale, `${key}_other`) !== undefined
  );
}

/** Every string leaf of a locale tree as `[dotted.key, value]`. */
function leaves(node, prefix = '', out = []) {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') leaves(value, full, out);
    else if (typeof value === 'string') out.push([full, value]);
  }
  return out;
}

/**
 * Per source file (relative to client/src, forward slashes): the distinct literal keys missing
 * from English or German, each with the line it is first used on.
 * @returns {Object<string, Map<string, number>>}
 */
function missingKeysByFile() {
  const result = {};
  for (const file of sourceFiles(SRC)) {
    const missing = new Map();
    for (const { key, line } of literalKeys(file)) {
      if (!missing.has(key) && (!known(en, key) || !known(de, key))) missing.set(key, line);
    }
    if (missing.size > 0) {
      result[path.relative(SRC, file).split(path.sep).join('/')] = missing;
    }
  }
  return result;
}

describe('translation keys used by the frontend', () => {
  const missingByFile = missingKeysByFile();

  it('are found in the source', () => {
    const used = sourceFiles(SRC).reduce((sum, file) => sum + literalKeys(file).length, 0);
    expect(used).toBeGreaterThan(5000);
  });

  it('exist in English and German, apart from the counts in the baseline', () => {
    const over = Object.entries(missingByFile)
      .filter(([file, missing]) => missing.size > (baseline[file] ?? 0))
      .map(
        ([file, missing]) =>
          `${file}: ${missing.size} missing, baseline ${baseline[file] ?? 0}: ` +
          [...missing].map(([key, line]) => `${key} (:${line})`).join(', ')
      );
    expect(over).toEqual([]);
  });

  it('have a baseline no higher than what is still missing (lower it when you add keys)', () => {
    const stale = Object.entries(baseline)
      .filter(([file, count]) => (missingByFile[file]?.size ?? 0) < count)
      .map(([file, count]) => {
        const now = missingByFile[file]?.size ?? 0;
        return now === 0
          ? `${file}: remove it from the baseline (was ${count})`
          : `${file}: lower the baseline from ${count} to ${now}`;
      });
    expect(stale).toEqual([]);
  });
});

describe('German translations', () => {
  it('have every admin key that English has', () => {
    const missing = leaves(en.admin, 'admin')
      .map(([key]) => key)
      .filter(key => lookup(de, key) === undefined);
    expect(missing).toEqual([]);
  });

  // The product addresses its readers formally. The response-style description is an instruction
  // to the model, written like its siblings ("Liefere …"), not text that addresses the reader.
  const INFORMAL_ALLOWED = ['responseStyles.descriptions.explanatory'];
  const INFORMAL = /\b(du|dich|dir|dein|deine|deinem|deinen|deiner|deines)\b/i;

  it('address the reader with "Sie", not "du"', () => {
    const informal = leaves(de)
      .filter(([key]) => !INFORMAL_ALLOWED.includes(key))
      // Interpolation placeholders such as {{dir}} are not words of the text.
      .filter(([, value]) => INFORMAL.test(value.replace(/\{\{[^}]*\}\}/g, '')))
      .map(([key, value]) => `${key}: ${value}`);
    expect(informal).toEqual([]);
  });
});
