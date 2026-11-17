// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every text the frontend asks for with a literal key, `t('some.key', 'Default')`, must exist in
 * the built-in locales, English and German. The server drops an override for a key the built-in
 * file does not know (configCache.mergeLocaleData), so a key that is only in the code cannot be
 * overridden by an admin and has no German text.
 *
 * This covers the whole client, the admin area included. The admin area still uses many keys
 * that exist only as inline defaults. Those are listed by name, per file, in
 * `translation-keys-baseline.json`, and that file can only shrink:
 *
 * - A missing key that is not listed for its file fails: add it to `shared/i18n/en.json` and
 *   `shared/i18n/de.json`. Every key added from now on must be in both. Swapping a listed key for
 *   a new missing one fails too, because the list holds names, not a count.
 * - A listed key that is no longer missing also fails: remove it from the baseline (and the file
 *   entry once its list is empty), so nobody can add it back later unnoticed.
 *
 * Not covered: the login gate (client/src/auth-gate has its own bundled table) and keys built at
 * run time (`t(\`a.${b}\`)`).
 *
 * Two German checks ride along: every key under `admin` in English also exists in German, and
 * German text addresses the reader formally (Sie, not du).
 */
import fs from 'fs';
import path from 'path';
import { tokenize } from 'espree';
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

// Keys without a dot are not translation keys of the client (the login gate has its own table).
const KEY = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/;

const TOKENIZE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  ecmaFeatures: { jsx: true },
  loc: true
};

/**
 * The text of a string literal or a template literal without substitutions, or null.
 * @param {{type: string, value: string}|undefined} token
 * @returns {string|null}
 */
function literalText(token) {
  if (!token) return null;
  if (token.type === 'String') return token.value.slice(1, -1);
  if (token.type === 'Template' && /^`[^`]*`$/.test(token.value)) return token.value.slice(1, -1);
  return null;
}

/**
 * The literal keys of `t('a.b')`, `t("a.b", …)`, `` t(`a.b`) `` and `i18n.t('a.b')` calls in
 * source text, with their line. The text is tokenized (espree, the parser ESLint uses), so
 * comments are skipped and a `/*` inside a string (`'audio/*'`) does not hide the code after it.
 * `x.t('a.b')` on any other object is not counted.
 * @param {string} source
 * @returns {Array<{key: string, line: number}>}
 */
function keysInSource(source) {
  const tokens = tokenize(source, TOKENIZE_OPTIONS);
  const keys = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    const token = tokens[i];
    if (token.type !== 'Identifier' || token.value !== 't') continue;
    const previous = tokens[i - 1];
    if (previous?.type === 'Punctuator' && (previous.value === '.' || previous.value === '?.')) {
      if (previous.value !== '.' || tokens[i - 2]?.value !== 'i18n') continue;
    }
    if (tokens[i + 1].type !== 'Punctuator' || tokens[i + 1].value !== '(') continue;
    const key = literalText(tokens[i + 2]);
    if (key !== null && KEY.test(key)) keys.push({ key, line: token.loc.start.line });
  }
  return keys;
}

function literalKeys(file) {
  return keysInSource(fs.readFileSync(file, 'utf8'));
}

/**
 * Missing keys the baseline does not list for their file, as `file:line: key`.
 * @param {Object<string, Map<string, number>>} missingByFile
 * @param {Object<string, string[]>} listedByFile
 * @returns {string[]}
 */
function unlistedMissingKeys(missingByFile, listedByFile) {
  return Object.entries(missingByFile).flatMap(([file, missing]) => {
    const listed = new Set(listedByFile[file] ?? []);
    return [...missing]
      .filter(([key]) => !listed.has(key))
      .map(([key, line]) => `${file}:${line}: ${key}`);
  });
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

describe('finding translation keys in source', () => {
  it('skips comments but not code after a "/*" inside a string', () => {
    const source = [
      "const accept = 'audio/*';",
      "const label = t('admin.after.audio', 'After');",
      "// t('admin.line.comment')",
      "/* t('admin.block.comment') */",
      'const url = `${base}/*`;',
      "const other = i18n.t('admin.after.template');",
      "const notOurs = form.t('admin.other.object');"
    ].join('\n');
    expect(keysInSource(source)).toEqual([
      { key: 'admin.after.audio', line: 2 },
      { key: 'admin.after.template', line: 6 }
    ]);
  });

  it('reads JSX text with apostrophes without losing its place', () => {
    const source = "const a = <p>Don't {t('admin.jsx.key')}</p>;";
    expect(keysInSource(source).map(({ key }) => key)).toEqual(['admin.jsx.key']);
  });

  it('catches a listed missing key swapped for a new one in the same file', () => {
    const missing = { 'a.jsx': new Map([['admin.new.key', 7]]) };
    expect(unlistedMissingKeys(missing, { 'a.jsx': ['admin.old.key'] })).toEqual([
      'a.jsx:7: admin.new.key'
    ]);
  });
});

describe('translation keys used by the frontend', () => {
  const missingByFile = missingKeysByFile();

  it('are found in the source', () => {
    const used = sourceFiles(SRC).reduce((sum, file) => sum + literalKeys(file).length, 0);
    expect(used).toBeGreaterThan(5000);
  });

  it('exist in English and German, apart from the keys listed in the baseline', () => {
    expect(unlistedMissingKeys(missingByFile, baseline)).toEqual([]);
  });

  it('have a baseline that lists only keys still missing (remove a key once you add it)', () => {
    const stale = Object.entries(baseline).flatMap(([file, keys]) => {
      const missing = missingByFile[file];
      const fixed = keys.filter(key => !missing?.has(key));
      if (fixed.length === 0) return [];
      return fixed.length === keys.length
        ? [`${file}: remove the file from the baseline`]
        : fixed.map(key => `${file}: remove ${key} from the baseline`);
    });
    expect(stale).toEqual([]);
  });

  it('have a baseline kept sorted, one entry per key', () => {
    const unsorted = Object.entries(baseline)
      .filter(([, keys]) => keys.join('\n') !== [...new Set(keys)].sort().join('\n'))
      .map(([file]) => file);
    expect(unsorted).toEqual([]);
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

  // Informal imperatives ("Wähle …", "Gib … ein") address the reader as "du" without the pronoun.
  // Sentence starts only, and only verbs that are never a progress status ("Prüfe…", "Lade…").
  const INFORMAL_IMPERATIVE =
    /(?:^|[.!?:]\s+)(Baue|Bestätige|Bewerte|Entferne|Füge|Gehe|Gib|Klicke|Öffne|Richte|Trage|Wähle)\s(?!Sie\b)/;

  it('use the formal imperative ("Wählen Sie"), not "Wähle"', () => {
    const informal = leaves(de)
      .filter(([, value]) => INFORMAL_IMPERATIVE.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(informal).toEqual([]);
  });
});
