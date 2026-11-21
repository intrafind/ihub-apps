// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The texts of the app builder (create page, app editor, apps list), where
 * `translation-keys-exist.test.jsx` cannot see them:
 *
 * - **Keys picked from a map.** That test reads only literal first arguments of `t()`. A key that
 *   code picks by an error code, a start kind or a group ID is never one. It is checked twice
 *   here. Each such map is exported, and every key in it must be a text in English and in German:
 *   the values of a map are full translation keys (`admin.apps.create.error.noModel`), directly
 *   or nested in objects and arrays, and `null` stands for "no message". And in the files of the
 *   app builder every string that names a key under `admin.`, wherever it stands, must be a text;
 *   that also covers a map nobody exported (`labelKey: 'admin.apps.edit.allowScripts'`).
 * - **Keys that name a group of keys.** `t()` renders an object as "returned an object instead of
 *   string". That test finds such a key only as a literal argument of `t()` and only in English;
 *   for the presence of a key it counts an object as present. In the files of the app builder
 *   every key, literal or picked from a map, must be a text in both languages.
 * - **„Nutzer".** German says „Benutzer" in the app administration.
 *
 * It does not repeat that test: literal keys of the rest of the client, German completeness for
 * `admin.*` and the formal address are checked there.
 */
import fs from 'fs';
import path from 'path';
import { tokenize } from 'espree';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const SRC = path.resolve('client/src');
const ADMIN = path.join(SRC, 'features/admin');
const APP_CREATE = path.join(ADMIN, 'components/app-create');
const APP_EDITOR = path.join(ADMIN, 'components/app-editor');
const APP_FORM = path.join(ADMIN, 'components/app-form');
const CREATE_PAGE = path.join(ADMIN, 'pages/AdminAppCreatePage.jsx');

const LOCALES = { en, de };

/**
 * The exported maps whose values are translation keys. `keys` reads the keys out of an export
 * that is not a plain map of them.
 */
const KEY_MAPS = [
  { name: 'GENERATE_ERROR_KEYS', file: path.join(APP_CREATE, 'generateErrors.js') },
  { name: 'CREATE_ERROR_KEYS', file: path.join(APP_CREATE, 'createErrors.js') },
  { name: 'STEP_KEYS', file: path.join(APP_CREATE, 'createKeys.js') },
  { name: 'HEADING_KEYS', file: path.join(APP_CREATE, 'createKeys.js') },
  { name: 'NOTE_KEYS', file: path.join(APP_CREATE, 'createKeys.js') },
  {
    name: 'EDITOR_GROUPS',
    file: path.join(APP_FORM, 'editorGroups.js'),
    keys: groups => groups.map(group => group.labelKey)
  },
  { name: 'GENERATE_CLIENT_ERROR_KEYS', file: path.join(APP_CREATE, 'generateErrors.js') },
  { name: 'FIELD_LABEL_KEYS', file: path.join(APP_CREATE, 'createKeys.js') },
  { name: 'COPY_NAME_KEY', file: path.join(APP_CREATE, 'copyLanguages.js') },
  { name: 'AUDIENCE_KEYS', file: path.join(APP_EDITOR, 'audienceText.js') },
  {
    name: 'NEXT_STEPS',
    file: path.join(APP_EDITOR, 'nextSteps.js'),
    keys: steps => steps.map(step => step.labelKey)
  }
];

/**
 * The files of the app builder, as directories and single files. Every key they name must be a
 * text. The first three are the ones the plan names; the pages and the parts of the editor page
 * get their texts from the same slice.
 */
const KEY_SOURCES = [
  APP_FORM,
  path.join(ADMIN, 'components/AppFormEditor.jsx'),
  APP_CREATE,
  APP_EDITOR,
  CREATE_PAGE,
  path.join(ADMIN, 'pages/AdminAppEditPage.jsx'),
  path.join(ADMIN, 'pages/AdminAppsPage.jsx')
];

const relative = file => path.relative(SRC, file).split(path.sep).join('/');

function lookup(locale, key) {
  return key
    .split('.')
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), locale);
}

const isFilled = value => typeof value === 'string' && value.trim() !== '';

/** True when `t(key)` renders a text: a string, or the two plural forms that `count` picks from. */
function isText(locale, key) {
  if (typeof key !== 'string') return false;
  return (
    isFilled(lookup(locale, key)) ||
    (isFilled(lookup(locale, `${key}_one`)) && isFilled(lookup(locale, `${key}_other`)))
  );
}

/** The languages in which `key` is not a text, as `['en', 'de']`. */
function languagesWithoutText(key) {
  return Object.entries(LOCALES)
    .filter(([, locale]) => !isText(locale, key))
    .map(([language]) => language);
}

/** Every string leaf of a locale tree as `[dotted.key, value]`. */
function leaves(node, prefix, out = []) {
  for (const [key, value] of Object.entries(node)) {
    const full = `${prefix}.${key}`;
    if (value && typeof value === 'object') leaves(value, full, out);
    else if (typeof value === 'string') out.push([full, value]);
  }
  return out;
}

/** Every leaf of a key map. `null` and `undefined` mean "no message" and are left out. */
function mapValues(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'object') Object.values(value).forEach(child => mapValues(child, out));
  else out.push(value);
  return out;
}

/**
 * The keys of one exported map, or the reason why there are none.
 * @param {{name: string, file: string, keys?: function(*): Array}} map
 * @returns {{keys: Array}|{missing: string}}
 */
function loadKeyMap(map) {
  if (!fs.existsSync(map.file)) return { missing: `${relative(map.file)} does not exist` };
  let exported;
  try {
    exported = require(map.file)[map.name];
  } catch (error) {
    return { missing: `${relative(map.file)} does not load: ${error.message}` };
  }
  if (exported === undefined) return { missing: `${relative(map.file)} does not export it` };
  const keys = map.keys ? map.keys(exported) : mapValues(exported);
  if (keys.length === 0) return { missing: `${relative(map.file)} exports it without a key` };
  return { keys };
}

function sourceFiles(source, out = []) {
  if (!fs.existsSync(source)) return out;
  if (!fs.statSync(source).isDirectory()) {
    out.push(source);
    return out;
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const full = path.join(source, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// A translation key has at least one dot (translation-keys-exist.test.jsx reads keys the same way).
const KEY = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/;
// A string that names a key of the admin area, wherever it stands in the source.
const ADMIN_KEY = /^admin(?:\.[\w-]+){2,}$/;

/**
 * The text of a string literal, a JSX attribute string or a template literal without
 * substitutions, or null.
 * @param {{type: string, value: string}|undefined} token
 * @returns {string|null}
 */
function literalText(token) {
  if (!token) return null;
  if (token.type === 'String') return token.value.slice(1, -1);
  if (token.type === 'JSXText' && /^(["']).*\1$/s.test(token.value))
    return token.value.slice(1, -1);
  if (token.type === 'Template' && /^`[^`]*`$/.test(token.value)) return token.value.slice(1, -1);
  return null;
}

/**
 * The translation keys source text names: the literal first argument of `t()` and `i18n.t()`
 * (any namespace), and every other string that is a key under `admin.` (a map value, a
 * `labelKey`, an `i18nKey` attribute, a branch of `t(a ? 'x' : 'y')`). The text is tokenized, so
 * comments are skipped.
 * @param {string} source
 * @returns {string[]}
 */
function keysInSource(source) {
  const tokens = tokenize(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true }
  });
  const keys = new Set();
  tokens.forEach((token, i) => {
    const text = literalText(token);
    if (text === null) return;
    if (ADMIN_KEY.test(text)) keys.add(text);
    if (!KEY.test(text) || tokens[i - 1]?.value !== '(' || tokens[i - 2]?.value !== 't') return;
    const before = tokens[i - 3];
    const isMember =
      before?.type === 'Punctuator' && (before.value === '.' || before.value === '?.');
    if (!isMember || (before.value === '.' && tokens[i - 4]?.value === 'i18n')) keys.add(text);
  });
  return [...keys];
}

const keysInFile = file => keysInSource(fs.readFileSync(file, 'utf8'));

describe('reading the keys of the app builder', () => {
  it('takes every leaf of a nested map and leaves out "no message"', () => {
    const map = { A: 'x.a', B: { limiter: 'x.b', other: 'x.c' }, C: ['x.d'], D: null };
    expect(mapValues(map)).toEqual(['x.a', 'x.b', 'x.c', 'x.d']);
  });

  it('finds literal keys of t() and keys under "admin." that stand anywhere else', () => {
    const source = [
      "const label = t('common.save', 'Save');",
      'const other = i18n.t(`appConfig.plainText`);',
      "const notOurs = form.t('pages.other.object');",
      "// t('admin.line.comment')",
      "const MAP = { A: 'admin.map.value', B: ['admin.map.inArray', 'Default'], C: null };",
      "const picked = t(open ? 'admin.branch.open' : 'admin.branch.closed');",
      'const node = <Trans i18nKey="admin.jsx.attribute">admin.jsx.text</Trans>;',
      'const built = t(`admin.built.${id}`);',
      "const path = 'variables.0.name';",
      "const area = 'admin.apps';"
    ].join('\n');
    expect(keysInSource(source).sort()).toEqual([
      'admin.branch.closed',
      'admin.branch.open',
      'admin.jsx.attribute',
      'admin.map.inArray',
      'admin.map.value',
      'appConfig.plainText',
      'common.save'
    ]);
  });

  it('tells a text from a group of keys, a missing key and half a plural', () => {
    const locale = { a: { text: 'Text', group: { leaf: 'Leaf' }, many_one: '1', many_other: 'n' } };
    locale.a.half_one = '1';
    locale.a.empty = '';
    expect(isText(locale, 'a.text')).toBe(true);
    expect(isText(locale, 'a.many')).toBe(true);
    expect(isText(locale, 'a.group')).toBe(false);
    expect(isText(locale, 'a.missing')).toBe(false);
    expect(isText(locale, 'a.half')).toBe(false);
    expect(isText(locale, 'a.empty')).toBe(false);
    expect(isText(locale, undefined)).toBe(false);
  });
});

describe('translation keys the app builder picks from a map', () => {
  for (const map of KEY_MAPS) {
    const loaded = loadKeyMap(map);
    const title = `${map.name}: every key is a text in English and German`;

    it(title, () => {
      expect(loaded.missing).toBeUndefined();
      const problems = loaded.keys
        .map(key => [key, languagesWithoutText(key)])
        .filter(([, languages]) => languages.length > 0)
        .map(([key, languages]) => `${String(key)}: no text in ${languages.join(', ')}`);
      expect(problems).toEqual([]);
    });
  }
});

describe('translation keys named in the files of the app builder', () => {
  for (const source of KEY_SOURCES) {
    const files = sourceFiles(source);
    const title = `${relative(source)}: every key is a text, not a group of keys`;

    const problems = files.flatMap(file =>
      keysInFile(file)
        .filter(key => languagesWithoutText(key).length > 0)
        .map(key => `${relative(file)}: ${key}`)
    );

    it(title, () => {
      expect(files.length).toBeGreaterThan(0);
      expect(problems).toEqual([]);
    });
  }

  it('finds the keys of the app form', () => {
    const found = sourceFiles(APP_FORM).reduce((sum, file) => sum + keysInFile(file).length, 0);
    expect(found).toBeGreaterThan(200);
  });
});

describe('texts of the app administration', () => {
  const english = leaves(en.admin.apps, 'admin.apps');
  const german = leaves(de.admin.apps, 'admin.apps');

  it('say „Benutzer", not „Nutzer", in German', () => {
    const informal = german
      .filter(([, value]) => /(?<!Be)nutzer/i.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(informal).toEqual([]);
  });

  it('have no German text without an English one', () => {
    const englishKeys = new Set(english.map(([key]) => key));
    expect(german.map(([key]) => key).filter(key => !englishKeys.has(key))).toEqual([]);
  });

  it('have both plural forms wherever they have one', () => {
    const half = Object.entries(LOCALES).flatMap(([language, locale]) =>
      leaves(locale.admin.apps, 'admin.apps')
        .map(([key]) => key.match(/^(.*)_(one|other)$/)?.[1])
        .filter(Boolean)
        .filter(base => !isText(locale, base))
        .map(base => `${language}: ${base}`)
    );
    expect(half).toEqual([]);
  });

  it('take the same values in English and German', () => {
    const placeholders = text => [...new Set(text.match(/\{\{[^}]*\}\}/g) ?? [])].sort();
    const germanText = Object.fromEntries(german);
    const different = english
      .filter(([key]) => typeof germanText[key] === 'string')
      .filter(([key, value]) => {
        return placeholders(value).join() !== placeholders(germanText[key]).join();
      })
      .map(([key]) => key);
    expect(different).toEqual([]);
  });
});
