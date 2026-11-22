// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The texts of personal apps (concepts/app-builder-rework-2026-11/02-personal-apps.md, section
 * 12), where `translation-keys-exist.test.jsx` cannot see them:
 *
 * - **Every key of section 12.** That test knows a key only once code asks for it with a literal
 *   `t('…')`. The list below is the copy table of the concept, key by key, so a text is missing
 *   here before a page is.
 * - **Keys picked from a map.** A state, a read-only reason, a capability, a role, a filter and
 *   an error code pick their key at run time (`userApps.edit.state.${state}`, or a map value).
 *   Every name such a map can hold must be a text, and every string in the client that names a
 *   key under `userApps.` or `admin.userApps.` must be one too, wherever it stands.
 * - **Keys that name a group of keys.** `t()` renders an object as "returned an object instead of
 *   string"; for the presence of a key that test counts an object as present.
 * - **The wording rules of section 12:** „Benutzer", the formal address, „…“, the same values in
 *   both languages, and the two words the concept retired.
 *
 * The file holds the keys, not the texts: the texts live in `shared/i18n/en.json` and `de.json`
 * only. A slice that needs one more key reports it to the owner of those files (section 21).
 */
import fs from 'fs';
import path from 'path';
import { tokenize } from 'espree';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import { USER_APP_ERROR_CODES } from '../../../shared/apiErrors.js';

/** The keys of section 12, per table, in the order of the tables. */
const SECTION_12 = {
  'userApps.list': [
    'new',
    'scope.all',
    'scope.mine',
    'scope.shared',
    'badge.mine',
    'badge.offered',
    'empty.mine',
    'empty.shared',
    'menu.edit',
    'menu.share',
    'menu.duplicate',
    'menu.delete',
    'menu.leave',
    'limitReached'
  ],
  'userApps.create': ['stateLine', 'limits', 'created'],
  'userApps.edit': [
    'state.private',
    'state.shared',
    'state.everyone',
    'state.promoted',
    'state.offered',
    'state.disabled',
    'extras.title',
    'extras.model',
    'extras.upload',
    'extras.webSearch',
    'extras.webSearchHelp',
    'extras.skills',
    'extras.integrations',
    'extras.approvalHelp',
    'extras.gone',
    'extras.remove',
    'conflict',
    'readOnly.ownerInactive',
    'readOnly.promoted',
    'readOnly.disabled',
    'readOnly.capability',
    'delete.title',
    'delete.body'
  ],
  'userApps.share': [
    'title',
    'help',
    'private',
    'role.user',
    'role.editor',
    'everyone',
    'copyLink',
    'linkCopied',
    'notAllowed'
  ],
  'userApps.publish': [
    'action',
    'titleNow',
    'titleLater',
    'bodyNow',
    'bodyLaterTools',
    'bodyLaterAlways',
    'willUse',
    'dropped',
    'plain',
    'managed',
    'membersNow',
    'membersLater',
    'submit',
    'waiting',
    'changed',
    'retired.title',
    'retired.open',
    'retired.chats'
  ],
  'userApps.transfer': [
    'action',
    'title',
    'line1',
    'line2',
    'line3',
    'submit',
    'withdraw',
    'received',
    'receivedDuty',
    'receivedMembers',
    'receivedEditors',
    'try',
    'decline',
    'accept',
    'changed',
    'tooMany'
  ],
  'userApps.notice': [
    'ownedBy',
    'mayUse',
    'switchOn',
    'asksFirst',
    'asksFirstSystems',
    'notForYou',
    'unavailable',
    'showInstructions',
    'collapsed',
    'suspended'
  ],
  'admin.userApps': [
    'tab',
    'tabWaiting',
    'featureOff',
    'featureOn',
    'filter.all',
    'filter.everyone',
    'filter.ownerInactive',
    'filter.ownerStale',
    'filter.waiting',
    'waiting.row',
    'waiting.open',
    'waiting.notice',
    'takeOver.action',
    'takeOver.title',
    'takeOver.willUse',
    'takeOver.dropped',
    'takeOver.plain',
    'takeOver.notPublished',
    'takeOver.owner',
    'takeOver.users',
    'takeOver.submit',
    'noAccess',
    'release.action',
    'release.published',
    'changed',
    'disable.action',
    'enable.action',
    'disable.body',
    'offerOwner',
    'revisions',
    'clash',
    'settings.title',
    'settings.shareWith',
    'settings.allowUsers',
    'settings.allowGroups',
    'settings.allowEveryone',
    'settings.allowPublish',
    'settings.allowPublishHelp',
    'settings.adminEnablesAlways',
    'settings.permissionHint',
    'settings.groupsCreate',
    'settings.groupsShare',
    'settings.limits',
    'settings.max',
    'settings.mayUse',
    'settings.integrationsHelp',
    'settings.blocked',
    'groups.userApps',
    'groups.userAppSharing',
    'groups.userAppsHint',
    'groups.userAppSharingHint',
    'user.count',
    'user.block',
    'user.blockBody'
  ],
  apiErrors: [
    'USER_APPS_DISABLED',
    'USER_APPS_UNAVAILABLE',
    'QUOTA_USER_APPS',
    'QUOTA_USER_APP_OFFERS',
    'USER_APP_CAPABILITY_DENIED',
    'USER_APP_ACCESS_CHANGED'
  ]
};

const SRC = path.resolve('client/src');
const LOCALES = { en, de };

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
  for (const [key, value] of Object.entries(node ?? {})) {
    const full = `${prefix}.${key}`;
    if (value && typeof value === 'object') leaves(value, full, out);
    else if (typeof value === 'string') out.push([full, value]);
  }
  return out;
}

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// A string that names a key of personal apps, wherever it stands in the source.
const USER_APPS_KEY = /^(?:admin\.)?userApps(?:\.[\w-]+)+$/;
// The start of a key that is completed at run time: `userApps.edit.state.${state}`.
const USER_APPS_GROUP = /^`((?:admin\.)?userApps(?:\.[\w-]+)+)\.\$\{$/;

/**
 * The text of a string literal, a JSX attribute string or a template literal without
 * substitutions, or null.
 * @param {{type: string, value: string}} token
 * @returns {string|null}
 */
function literalText(token) {
  if (token.type === 'String') return token.value.slice(1, -1);
  if (token.type === 'JSXText' && /^(["']).*\1$/s.test(token.value))
    return token.value.slice(1, -1);
  if (token.type === 'Template' && /^`[^`]*`$/.test(token.value)) return token.value.slice(1, -1);
  return null;
}

/**
 * What source text names of the texts of personal apps. `keys` are the full keys, as an argument
 * of `t()` or anywhere else (a map value, a `labelKey`, an `i18nKey` attribute, a branch of a
 * condition). `groups` are the groups a key is picked from at run time, read from the start of a
 * template literal. The text is tokenized, so comments are skipped.
 * @param {string} source
 * @returns {{keys: string[], groups: string[]}}
 */
function namedInSource(source) {
  const tokens = tokenize(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true }
  });
  const keys = new Set();
  const groups = new Set();
  for (const token of tokens) {
    const text = literalText(token);
    if (text !== null && USER_APPS_KEY.test(text)) keys.add(text);
    const group = token.type === 'Template' ? token.value.match(USER_APPS_GROUP) : null;
    if (group) groups.add(group[1]);
  }
  return { keys: [...keys], groups: [...groups] };
}

const SECTION_12_KEYS = Object.entries(SECTION_12).flatMap(([prefix, keys]) =>
  keys.map(key => `${prefix}.${key}`)
);

const TREES = [
  ['userApps', locale => locale.userApps],
  ['admin.userApps', locale => locale.admin?.userApps]
];

/** The texts of personal apps in one language, the six error texts included. */
function userAppTexts(locale) {
  const errors = SECTION_12.apiErrors.map(code => [`apiErrors.${code}`, locale.apiErrors?.[code]]);
  return [
    ...TREES.flatMap(([prefix, pick]) => leaves(pick(locale), prefix)),
    ...errors.filter(([, value]) => typeof value === 'string')
  ];
}

describe('reading the keys of personal apps', () => {
  it('finds full keys wherever they stand, and the group of a key built at run time', () => {
    const source = [
      "const label = t('userApps.list.new');",
      "// t('userApps.line.comment')",
      "const MAP = { private: 'userApps.edit.state.private', gone: null };",
      "const picked = t(open ? 'admin.userApps.tab' : 'admin.userApps.tabWaiting');",
      'const node = <Trans i18nKey="userApps.notice.ownedBy" />;',
      'const built = t(`userApps.share.role.${role}`);',
      "const feature = 'userApps';",
      "const other = t('admin.apps.create.title');"
    ].join('\n');
    const { keys, groups } = namedInSource(source);
    expect(keys.sort()).toEqual([
      'admin.userApps.tab',
      'admin.userApps.tabWaiting',
      'userApps.edit.state.private',
      'userApps.list.new',
      'userApps.notice.ownedBy'
    ]);
    expect(groups).toEqual(['userApps.share.role']);
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
  });
});

describe('the copy of personal apps (concept section 12)', () => {
  it('lists every key once', () => {
    expect(SECTION_12_KEYS.length).toBe(153);
    expect(new Set(SECTION_12_KEYS).size).toBe(SECTION_12_KEYS.length);
  });

  for (const [prefix, keys] of Object.entries(SECTION_12)) {
    it(`${prefix}: every key is a text in English and German`, () => {
      const problems = keys
        .map(key => `${prefix}.${key}`)
        .map(key => [key, languagesWithoutText(key)])
        .filter(([, languages]) => languages.length > 0)
        .map(([key, languages]) => `${key}: no text in ${languages.join(', ')}`);
      expect(problems).toEqual([]);
    });
  }

  it('has a text for every state, read-only reason, capability and role picked from a map', () => {
    const picked = {
      'userApps.edit.state': ['private', 'shared', 'everyone', 'promoted', 'offered', 'disabled'],
      'userApps.edit.readOnly': ['ownerInactive', 'promoted', 'disabled', 'capability'],
      'userApps.edit.extras': ['model', 'upload', 'webSearch', 'skills', 'integrations'],
      'userApps.share.role': ['user', 'editor'],
      'userApps.list.scope': ['all', 'mine', 'shared'],
      'admin.userApps.filter': ['all', 'everyone', 'ownerInactive', 'ownerStale', 'waiting'],
      apiErrors: Object.keys(USER_APP_ERROR_CODES)
    };
    const problems = Object.entries(picked).flatMap(([group, names]) =>
      names.map(name => `${group}.${name}`).filter(key => languagesWithoutText(key).length > 0)
    );
    expect(problems).toEqual([]);
  });

  it('has an error text for exactly the codes of the registry', () => {
    expect([...SECTION_12.apiErrors].sort()).toEqual(Object.keys(USER_APP_ERROR_CODES).sort());
  });
});

describe('keys of personal apps named in the client', () => {
  const named = sourceFiles(SRC).map(file => [file, namedInSource(fs.readFileSync(file, 'utf8'))]);

  it('are texts in English and German, not groups of keys', () => {
    const problems = named.flatMap(([file, { keys }]) =>
      keys
        .map(key => [key, languagesWithoutText(key)])
        .filter(([, languages]) => languages.length > 0)
        .map(([key, languages]) => `${relative(file)}: ${key}: no text in ${languages.join(', ')}`)
    );
    expect(problems).toEqual([]);
  });

  it('are picked at run time only from a group that holds texts in both languages', () => {
    const problems = named.flatMap(([file, { groups }]) =>
      groups
        .filter(group =>
          Object.values(LOCALES).some(locale => {
            const node = lookup(locale, group);
            return !node || typeof node !== 'object' || !Object.values(node).some(isFilled);
          })
        )
        .map(group => `${relative(file)}: ${group}`)
    );
    expect(problems).toEqual([]);
  });
});

describe('texts of personal apps', () => {
  const english = userAppTexts(en);
  const german = userAppTexts(de);

  it('have the same keys in English and German', () => {
    expect(german.map(([key]) => key).sort()).toEqual(english.map(([key]) => key).sort());
  });

  it('take the same values in English and German', () => {
    const placeholders = text => [...new Set(text.match(/\{\{[^}]*\}\}/g) ?? [])].sort();
    const germanText = Object.fromEntries(german);
    const different = english
      .filter(([key]) => typeof germanText[key] === 'string')
      .filter(([key, value]) => placeholders(value).join() !== placeholders(germanText[key]).join())
      .map(([key]) => key);
    expect(different).toEqual([]);
  });

  it('say „Benutzer", not „Nutzer", in German', () => {
    const informal = german
      .filter(([, value]) => /(?<!Be)nutzer/i.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(informal).toEqual([]);
  });

  it('address the reader with „Sie" in German', () => {
    const familiar = german
      .filter(([, value]) => /\b(du|dich|dir|dein\w*|euch|euer|eure\w*)\b/.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(familiar).toEqual([]);
  });

  it('quote with „…“ in German and never leave a quotation open', () => {
    const wrong = german
      .filter(([, value]) => {
        const open = (value.match(/„/g) ?? []).length;
        return value.includes('"') || open !== (value.match(/“/g) ?? []).length;
      })
      .map(([key, value]) => `${key}: ${value}`);
    expect(wrong).toEqual([]);
  });

  it('use one word per thing', () => {
    const texts = [...english, ...german];
    // "extras" is a key, never a word a person reads; a sentence names the things.
    expect(texts.filter(([, value]) => /\bextras\b/i.test(value)).map(([key]) => key)).toEqual([]);
    // "Handed over" was the old name of the state after an administrator took the app.
    expect(texts.filter(([, value]) => /handed over/i.test(value)).map(([key]) => key)).toEqual([]);
    // The state after publishing has one name, on the app and in the admin list.
    expect(en.userApps.edit.state.promoted).toBe('Now with the administrators');
    expect(de.userApps.edit.state.promoted).toBe('Jetzt bei den Administratoren');
  });
});
