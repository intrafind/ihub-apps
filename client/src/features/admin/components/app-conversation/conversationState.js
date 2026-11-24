// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The pure parts of the app builder's conversation: what a turn sends, when a
 * proposed change can still be applied, when an applied one can be undone,
 * what a ticked suggestion adds, how the conversation is kept in the tab, and
 * the message keys the change card picks by a value.
 *
 * Both editors use it: `target` is `'admin'` for an app of the admin area and
 * `'personal'` for a personal app, whose form holds `capabilities` instead of
 * `websearch` and `integrations`.
 *
 * Pure apart from the two storage functions, which catch every error. No
 * function modifies its argument.
 *
 * Plan: concepts/app-builder-rework-2026-11/04-chat-builder-implementation-plan.md,
 * sections 2.4, 2.5 and 3.
 *
 * @module features/admin/components/app-conversation/conversationState
 */

import {
  REVISE_AUTHOR_TEXT_MAX,
  REVISE_BUILDER_TEXT_MAX,
  REVISE_CONVERSATION_MAX,
  appRevisionKeys,
  appSettingsKeys,
  applyRevisionPatch
} from '../../../../../../shared/appRevision.js';
import { APP_GENERATOR_WARNINGS } from '../../../../../../shared/appGenerator.js';
import { pickUserAppContent } from '../../../../../../shared/userAppContent.js';

/** The suggestions under the builder's first message; each is sent as the author's message. */
export const STARTER_CHIP_KEYS = Object.freeze([
  'admin.apps.conversation.chips.shorter',
  'admin.apps.conversation.chips.examples',
  'admin.apps.conversation.chips.inputs'
]);

/** After this many turns the panel suggests to start over (plan 2.5). */
export const LONG_CONVERSATION_TURNS = 20;

/** The heading of each changed key on the change card, as the author reads it (plan 3.1). */
export const CHANGE_FIELD_KEYS = Object.freeze({
  name: 'admin.apps.conversation.field.name',
  description: 'admin.apps.conversation.field.description',
  system: 'admin.apps.conversation.field.system',
  prompt: 'admin.apps.conversation.field.prompt',
  messagePlaceholder: 'admin.apps.conversation.field.messagePlaceholder',
  variables: 'admin.apps.conversation.field.variables',
  starterPrompts: 'admin.apps.conversation.field.starterPrompts',
  category: 'admin.apps.conversation.field.category',
  look: 'admin.apps.conversation.field.look',
  // The settings of the registry (`shared/userAppFields.js`), one heading each.
  greeting: 'admin.apps.conversation.field.greeting',
  inputMode: 'admin.apps.conversation.field.inputMode',
  preferredOutputFormat: 'admin.apps.conversation.field.preferredOutputFormat',
  startForm: 'admin.apps.conversation.field.startForm',
  variablesPanel: 'admin.apps.conversation.field.variablesPanel',
  autoStart: 'admin.apps.conversation.field.autoStart'
});

/** The keys a change sets through `change.settings`, for either target. */
const SETTING_KEYS = new Set([...appSettingsKeys('admin'), ...appSettingsKeys('personal')]);

/** The keys shown together under "Look". */
const LOOK_KEYS = Object.freeze(['color', 'icon']);

/**
 * The sentence for a warning of an answer: by code for the revision's own
 * codes, by kind for the codes of the draft sanitiser (`APP_GENERATOR_WARNINGS`:
 * dropped, shortened, replaced, added, ignored), and `other` for a code this
 * client does not know.
 */
export const WARNING_KEYS = Object.freeze({
  OTHER_LANGUAGES_UNCHANGED: 'admin.apps.conversation.warning.otherLanguages',
  NO_CHANGE: 'admin.apps.conversation.warning.noChange',
  dropped: 'admin.apps.conversation.warning.dropped',
  shortened: 'admin.apps.conversation.warning.shortened',
  replaced: 'admin.apps.conversation.warning.replaced',
  added: 'admin.apps.conversation.warning.added',
  ignored: 'admin.apps.conversation.warning.ignored',
  other: 'admin.apps.conversation.warning.other'
});

/**
 * The message key of a warning.
 *
 * @param {{ code?: string }} warning
 * @returns {string}
 */
export function warningKey(warning) {
  const code = typeof warning?.code === 'string' ? warning.code : '';
  if (Object.hasOwn(WARNING_KEYS, code) && code === code.toUpperCase()) return WARNING_KEYS[code];
  const kind = Object.hasOwn(APP_GENERATOR_WARNINGS, code) ? APP_GENERATOR_WARNINGS[code] : null;
  return kind && WARNING_KEYS[kind] ? WARNING_KEYS[kind] : WARNING_KEYS.other;
}

/** The lines of the stakes line, by case (plan 2.8). */
export const STAKES_KEYS = Object.freeze({
  publishedGroups: 'admin.apps.conversation.stakes.publishedGroups',
  publishedEveryone: 'admin.apps.conversation.stakes.publishedEveryone',
  publishedSignedIn: 'admin.apps.conversation.stakes.publishedSignedIn',
  published: 'admin.apps.conversation.stakes.published',
  notPublished: 'admin.apps.conversation.stakes.notPublished',
  sharedEveryone: 'admin.apps.conversation.stakes.sharedEveryone',
  shared: 'admin.apps.conversation.stakes.shared',
  onlyYou: 'admin.apps.conversation.stakes.onlyYou',
  integrations: 'admin.apps.conversation.stakes.integrations'
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Code-point order: the same in every browser and locale, unlike `localeCompare`. */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A value with the keys of every object sorted, so that equal values serialise equally. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(byCodePoint)
      .filter(key => value[key] !== undefined)
      .map(key => [key, canonical(value[key])])
  );
}

/**
 * Whether two values hold the same data, whatever the order of their keys.
 * `undefined` and a missing key are the same.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameValue(a, b) {
  return JSON.stringify(canonical(a) ?? null) === JSON.stringify(canonical(b) ?? null);
}

/** A value that says nothing: absent, or an empty string. */
const isBlank = value => value === undefined || value === null || value === '';

/**
 * A setting that is "not set": the form holds one as an empty object, an empty
 * text or `false`; an app file as nothing at all.
 */
const isUnsetSetting = value =>
  isBlank(value) || value === false || (isPlainObject(value) && Object.keys(value).length === 0);

/**
 * The content a turn sends as `draft`: the keys a revision may change, as the
 * form holds them. A key without a value (a personal app without a colour) is
 * left out rather than sent empty.
 *
 * @param {object|null} form - The app as the editor holds it.
 * @param {'admin'|'personal'} target
 * @returns {object}
 */
export function draftOf(form, target) {
  const draft = {};
  if (!isPlainObject(form)) return draft;
  for (const key of appRevisionKeys(target)) {
    if (!isBlank(form[key])) draft[key] = form[key];
  }
  // The settings the builder may set, where the app has one: the model reads them, and a
  // change of one makes a proposal stale like a change of a text does. They are read the way
  // a personal app stores them: only the parts an author sets, and not what every new app
  // starts with (the default greeting, the input line with its microphone), which the form
  // of an admin app is padded with.
  const looks = pickUserAppContent(form);
  for (const key of appSettingsKeys(target)) {
    if (!isUnsetSetting(looks[key])) draft[key] = looks[key];
  }
  return draft;
}

/**
 * Whether the form's content changed since a turn sent it (plan 2.4, step 1):
 * the author typed in the form meanwhile, so the change was made for an app
 * that no longer exists and must be asked for again.
 *
 * @param {object|null} form
 * @param {object} baseSnapshot - The `draft` the turn sent.
 * @param {'admin'|'personal'} target
 * @returns {boolean}
 */
export function contentChangedSince(form, baseSnapshot, target) {
  return !sameValue(draftOf(form, target), baseSnapshot || {});
}

/**
 * Whether the form has unsaved changes a change does not make: Apply and Undo
 * save the whole form, so they would save those too, and the change card says
 * so (and the admin editor checks the form first, as Save does). Every key of
 * the form and of the saved app counts, content keys included: an unsaved
 * description goes with a change of the instructions. Only the keys the change
 * itself writes are left out ({@link changeKeysOf}).
 *
 * @param {object|null} form - The app as the editor holds it.
 * @param {object|null} saved - The app as it was last loaded or saved.
 * @param {string[]} changeKeys - The keys the change writes.
 * @returns {boolean}
 * @example
 * unsavedOutsideChange({ name: 'B', system: 'x' }, { name: 'A', system: 'y' }, ['system']); // → true
 * unsavedOutsideChange({ name: 'A', system: 'x' }, { name: 'A', system: 'y' }, ['system']); // → false
 */
export function unsavedOutsideChange(form, saved, changeKeys) {
  if (!isPlainObject(form) || !isPlainObject(saved)) return false;
  const own = new Set(Array.isArray(changeKeys) ? changeKeys : []);
  const keys = new Set([...Object.keys(form), ...Object.keys(saved)]);
  return [...keys].some(key => !own.has(key) && !sameValue(form[key], saved[key]));
}

/**
 * The suggestions of an answer the form does not have yet: web search when it
 * is off, and the connected systems that are not bound.
 *
 * @param {'admin'|'personal'} target
 * @param {object|null} form
 * @param {{ websearch?: boolean, integrations?: Array<{ id: string, label?: string, actions?: string[] }> }|null} suggestions
 * @returns {{ webSearch: boolean, integrations: Array<{ id: string, label: string, actions: string[] }> }}
 */
export function offeredSuggestions(target, form, suggestions) {
  const source = isPlainObject(suggestions) ? suggestions : {};
  const personal = target === 'personal';
  const capabilities = isPlainObject(form?.capabilities) ? form.capabilities : {};
  const webSearchOn = personal
    ? capabilities.webSearch === true
    : form?.websearch?.enabled === true;
  const bound = new Set(
    personal
      ? (Array.isArray(capabilities.integrations) ? capabilities.integrations : []).map(
          binding => binding?.id
        )
      : Object.keys(isPlainObject(form?.integrations) ? form.integrations : {})
  );
  const integrations = (Array.isArray(source.integrations) ? source.integrations : [])
    .filter(system => isPlainObject(system) && typeof system.id === 'string')
    .filter(system => !bound.has(system.id))
    .map(system => ({
      id: system.id,
      label: typeof system.label === 'string' && system.label ? system.label : system.id,
      actions: Array.isArray(system.actions)
        ? system.actions.filter(action => typeof action === 'string')
        : []
    }));
  return { webSearch: source.websearch === true && !webSearchOn, integrations };
}

/**
 * What the ticked suggestions add to the form: whole values of the keys they
 * touch (`websearch` and `integrations` of an admin app, `capabilities` of a
 * personal app), to be saved with the change. The save route stays the
 * authority on whether the app may have them.
 *
 * @param {'admin'|'personal'} target
 * @param {object} form
 * @param {{ webSearch: boolean, integrations: object[] }} offered - {@link offeredSuggestions}.
 * @param {{ webSearch?: boolean, integrationIds?: string[] }} ticked
 * @returns {object} Possibly empty.
 */
export function suggestionChanges(target, form, offered, ticked) {
  const wantSearch = ticked?.webSearch === true && offered.webSearch;
  const wanted = new Set(Array.isArray(ticked?.integrationIds) ? ticked.integrationIds : []);
  const systems = offered.integrations.filter(system => wanted.has(system.id));
  if (!wantSearch && systems.length === 0) return {};

  if (target === 'personal') {
    const capabilities = isPlainObject(form.capabilities) ? form.capabilities : {};
    const current = Array.isArray(capabilities.integrations) ? capabilities.integrations : [];
    return {
      capabilities: {
        ...capabilities,
        ...(wantSearch ? { webSearch: true } : {}),
        integrations: [
          ...current,
          ...systems.map(system => ({ id: system.id, actions: [...system.actions] }))
        ]
      }
    };
  }

  const changes = {};
  if (wantSearch) changes.websearch = { ...(form.websearch || {}), enabled: true };
  if (systems.length > 0) {
    changes.integrations = {
      ...(isPlainObject(form.integrations) ? form.integrations : {}),
      ...Object.fromEntries(
        systems.map(system => [
          system.id,
          system.actions.length > 0 ? { actions: [...system.actions] } : {}
        ])
      )
    };
  }
  return changes;
}

/**
 * What Apply merges over the form: the change's patch and what the ticked
 * suggestions add ({@link suggestionChanges}).
 *
 * @param {'admin'|'personal'} target
 * @param {object} form
 * @param {{ patch?: object, suggestions?: object }} entry - The change entry.
 * @param {{ webSearch?: boolean, integrationIds?: string[] }} [ticked]
 * @returns {object}
 */
export function changesOf(target, form, entry, ticked) {
  const offered = offeredSuggestions(target, form, entry?.suggestions);
  return {
    ...(isPlainObject(entry?.patch) ? entry.patch : {}),
    ...suggestionChanges(target, form || {}, offered, ticked)
  };
}

/**
 * The keys a change writes when it is saved: for a proposed change the keys
 * of its patch and of the ticked suggestions ({@link changesOf}); for an
 * applied one the keys Apply set or removed, which Undo puts back.
 *
 * @param {'admin'|'personal'} target
 * @param {object|null} form
 * @param {object} entry - The change entry.
 * @param {{ webSearch?: boolean, integrationIds?: string[] }} [ticked]
 * @returns {string[]}
 */
export function changeKeysOf(target, form, entry, ticked) {
  const applied = entry?.before || entry?.applied;
  if (applied && ['applied', 'undoing', 'kept', 'undone'].includes(entry.status)) {
    return [
      ...Object.keys(isPlainObject(applied.values) ? applied.values : {}),
      ...(Array.isArray(applied.missing) ? applied.missing : [])
    ];
  }
  return Object.keys(changesOf(target, form, entry, ticked));
}

/**
 * The values the form holds for some keys, to put back later; a key the form
 * does not have is listed in `missing`, so that putting back removes it.
 *
 * @param {object} form
 * @param {string[]} keys
 * @returns {{ values: object, missing: string[] }}
 */
export function valuesOf(form, keys) {
  const values = {};
  const missing = [];
  for (const key of keys) {
    if (form && Object.hasOwn(form, key) && form[key] !== undefined) values[key] = form[key];
    else missing.push(key);
  }
  return { values, missing };
}

/**
 * The form with earlier values put back (Undo).
 *
 * @param {object} form
 * @param {{ values: object, missing: string[] }} before - {@link valuesOf} of the form before Apply.
 * @returns {object} A new object.
 */
export function restoreValues(form, before) {
  const next = applyRevisionPatch(form, before?.values);
  const copy = next === form ? { ...form } : next;
  for (const key of before?.missing || []) delete copy[key];
  return copy;
}

/**
 * Whether an applied change can still be undone: every key it set still holds
 * the value Apply saved (plan 2.4). A key someone changed since (in the form,
 * or by a save the editor took in) would be overwritten by Undo.
 *
 * @param {object|null} form
 * @param {{ values: object, missing?: string[] }} applied - What Apply saved, by key,
 *   and the keys it removed.
 * @returns {boolean}
 */
export function stillApplied(form, applied) {
  if (!isPlainObject(form) || !isPlainObject(applied?.values)) return false;
  // A key the change removed (a `null` in the patch) must still be absent.
  const removed = Array.isArray(applied.missing) ? applied.missing : [];
  return (
    Object.entries(applied.values).every(([key, value]) => sameValue(form[key], value)) &&
    removed.every(key => isBlank(form[key]))
  );
}

/** A text cut to a maximum length. */
const clip = (text, max) => (typeof text === 'string' ? text.slice(0, max) : '');

/**
 * The conversation as a turn sends it: the last 12 entries, each with its
 * role, its kind (builder only) and its text within the limits of the route.
 * A question is sent with its own wording; the choices are not. An entry
 * without text is left out, except a builder's change: the server counts the
 * questions since the last change (`questionsSinceLastChange`), and a change
 * the model sent without a sentence must still reset that count.
 *
 * @param {object[]} entries - The entries of the conversation.
 * @returns {Array<{ role: 'author'|'builder', kind?: string, text: string }>}
 */
export function wireConversation(entries) {
  return (Array.isArray(entries) ? entries : [])
    .slice(-REVISE_CONVERSATION_MAX)
    .map(entry =>
      entry.role === 'author'
        ? { role: 'author', text: clip(entry.text, REVISE_AUTHOR_TEXT_MAX) }
        : {
            role: 'builder',
            kind: entry.kind,
            text: clip(
              entry.kind === 'question' && entry.question?.text ? entry.question.text : entry.text,
              REVISE_BUILDER_TEXT_MAX
            )
          }
    )
    .filter(
      entry => entry.text.trim() !== '' || (entry.role === 'builder' && entry.kind === 'change')
    );
}

/**
 * The heading keys of a change, in the order of the card: one per changed
 * key, colour and icon together under "Look". Keys the author does not edit
 * (`allowEmptyContent`, which follows the input fields) have no heading.
 *
 * @param {string[]} keys - The changed keys.
 * @returns {Array<{ id: string, keys: string[], labelKey: string }>}
 */
export function changeSections(keys) {
  const sections = [];
  const look = keys.filter(key => LOOK_KEYS.includes(key));
  for (const key of keys) {
    if (LOOK_KEYS.includes(key)) continue;
    if (CHANGE_FIELD_KEYS[key])
      sections.push({ id: key, keys: [key], labelKey: CHANGE_FIELD_KEYS[key] });
  }
  if (look.length > 0) sections.push({ id: 'look', keys: look, labelKey: CHANGE_FIELD_KEYS.look });
  return sections;
}

/** The text of a localized value in a language, or of its only language. */
function textIn(value, language) {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return '';
  if (typeof value[language] === 'string') return value[language];
  return '';
}

/** The label of an input field or an example question in a language. */
function labelIn(value, language) {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return '';
  return typeof value[language] === 'string'
    ? value[language]
    : Object.values(value).find(text => typeof text === 'string') || '';
}

/** The message key of an input field's type, as the form's type picker names it. */
const FIELD_TYPE_KEYS = Object.freeze({
  string: 'admin.apps.edit.typeString',
  text: 'admin.apps.edit.typeText',
  select: 'admin.apps.edit.typeSelect',
  date: 'admin.apps.edit.typeDate',
  number: 'admin.apps.edit.typeNumber',
  boolean: 'admin.apps.conversation.line.typeBoolean'
});

/**
 * One input field as one line of the change card: its label, whether it is
 * required, its type, its options and its default. Every part a change can
 * make is in the line, so a change of the type or the default shows as a
 * changed line rather than as two equal ones.
 *
 * @param {object} variable
 * @param {string} language
 * @param {(key: string, values?: object) => string} t
 * @returns {string}
 */
function fieldLine(variable, language, t) {
  const label = labelIn(variable.label, language) || variable.name || '';
  const required = variable.required ? ` ${t('admin.apps.conversation.line.required')}` : '';
  const type = variable.type || 'string';
  const typeName = FIELD_TYPE_KEYS[type] ? t(FIELD_TYPE_KEYS[type]) : String(type);
  const options = (Array.isArray(variable.predefinedValues) ? variable.predefinedValues : [])
    .map(option => labelIn(option?.label, language) || option?.value)
    .filter(Boolean);
  const defaultText = labelIn(variable.defaultValue, language);
  const parts = [
    `${label}${required}`,
    options.length > 0 ? `${typeName} (${options.join(', ')})` : typeName,
    ...(defaultText ? [t('admin.apps.conversation.line.default', { value: defaultText })] : [])
  ];
  return parts.join(' · ');
}

/**
 * The line of a setting as the change card compares it: what the setting is
 * now, in a plain sentence. A setting that is off, removed or never set has no
 * line, so that turning it on shows as an added line and removing it as a
 * removed one.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {(key: string, values?: object) => string} t
 * @returns {string[]}
 */
function settingLines(key, value, t) {
  if (key === 'greeting') {
    return Object.entries(isPlainObject(value) ? value : {})
      .filter(([, entry]) => isPlainObject(entry))
      .map(([lang, entry]) => `${lang}: ${entry.title ?? ''} / ${entry.subtitle ?? ''}`);
  }
  if (key === 'inputMode') {
    const parts = [];
    if (value?.type === 'singleline') parts.push(t('admin.apps.edit.singleLine'));
    if (value?.type === 'multiline') parts.push(t('admin.apps.edit.multiLine'));
    if (Number.isInteger(Number(value?.rows)) && value?.rows !== undefined) {
      parts.push(t('admin.apps.conversation.line.rows', { count: Number(value.rows) }));
    }
    return parts.length > 0 ? [parts.join(' · ')] : [];
  }
  if (key === 'preferredOutputFormat') {
    if (value === 'text') return [t('admin.apps.conversation.line.formatText')];
    if (value === 'markdown') return [t('admin.apps.conversation.line.formatMarkdown')];
    return [];
  }
  if (key === 'startForm') {
    if (!isPlainObject(value) || typeof value.enabled !== 'boolean') return [];
    const label = labelIn(value.submitLabel, '');
    return [
      value.enabled
        ? t('admin.apps.conversation.line.startFormOn', { label })
        : t('admin.apps.conversation.line.startFormOff')
    ];
  }
  if (key === 'variablesPanel') {
    if (typeof value?.pinned !== 'boolean') return [];
    return [
      value.pinned
        ? t('admin.apps.conversation.line.panelPinned')
        : t('admin.apps.conversation.line.panelCollapsed')
    ];
  }
  if (key === 'autoStart')
    return value === true ? [t('admin.apps.conversation.line.autoStart')] : [];
  return [];
}

/**
 * The lines the change card compares for a key: a text by its own lines, an
 * input field or an example question as one line each, a colour or icon as
 * one line. Pure data, so that the card can diff any key the same way.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {string} language
 * @param {(key: string, values?: object) => string} t - For the words of a line.
 * @returns {string[]}
 */
export function linesOf(key, value, language, t) {
  if (key === 'variables') {
    return (Array.isArray(value) ? value : [])
      .filter(isPlainObject)
      .map(variable => fieldLine(variable, language, t));
  }
  if (key === 'starterPrompts') {
    return (Array.isArray(value) ? value : []).filter(isPlainObject).map(prompt => {
      const title = labelIn(prompt.title, language);
      const message = labelIn(prompt.message, language);
      return title && message && title !== message ? `${title}: ${message}` : title || message;
    });
  }
  if (key === 'color') {
    return typeof value === 'string' && value
      ? [t('admin.apps.conversation.line.color', { value })]
      : [];
  }
  if (key === 'icon') {
    return typeof value === 'string' && value
      ? [t('admin.apps.conversation.line.icon', { value })]
      : [];
  }
  if (key === 'category') return typeof value === 'string' && value ? [value] : [];
  if (SETTING_KEYS.has(key)) return settingLines(key, value, t);
  const text = textIn(value, language);
  return text === '' ? [] : text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
}

/**
 * The languages of a localized key whose text a change touches, the content
 * language first. A key that is not localized has the one language `''`.
 *
 * @param {string} key
 * @param {unknown} before
 * @param {unknown} after
 * @param {string} language
 * @returns {string[]}
 */
export function changedLanguages(key, before, after, language) {
  // A setting is compared as a whole, not language by language: a greeting names its
  // languages in its own lines.
  if (SETTING_KEYS.has(key)) return [''];
  if (!isPlainObject(before) && !isPlainObject(after)) return [''];
  if (['variables', 'starterPrompts'].includes(key)) return [language];
  const all = new Set([
    ...Object.keys(isPlainObject(before) ? before : {}),
    ...Object.keys(isPlainObject(after) ? after : {})
  ]);
  const touched = [...all].filter(lang => textIn(before, lang) !== textIn(after, lang));
  if (touched.length === 0) return [language];
  return [...touched].sort((a, b) => (a === language ? -1 : b === language ? 1 : 0));
}

/** The storage key of an app's conversation. */
export const conversationStorageKey = (target, appId) => `ihub.appConversation.${target}.${appId}`;

/** The status a change is read back with when its save was still running. */
const UNSETTLED_STATUS = Object.freeze({ applying: 'proposed', undoing: 'applied' });

/** An empty conversation. */
export const EMPTY_CONVERSATION = Object.freeze({ entries: [], turns: 0, nextId: 1 });

/**
 * The conversation kept for an app in this tab, or an empty one. Storage that
 * is blocked, full or holds something else gives an empty one.
 *
 * @param {string} key
 * @returns {{ entries: object[], turns: number, nextId: number }}
 */
export function readConversation(key) {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return EMPTY_CONVERSATION;
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.entries)) return EMPTY_CONVERSATION;
    const entries = parsed.entries.filter(
      entry => isPlainObject(entry) && (entry.role === 'author' || entry.role === 'builder')
    );
    return {
      // A save that was running when the page went away has no answer coming: an
      // Apply goes back to the proposal, an Undo to the applied change.
      entries: entries.map(entry => {
        const settled = UNSETTLED_STATUS[entry.status];
        return settled ? { ...entry, status: settled } : entry;
      }),
      turns: Number.isInteger(parsed.turns) ? parsed.turns : 0,
      nextId: Number.isInteger(parsed.nextId) ? parsed.nextId : entries.length + 1
    };
  } catch {
    return EMPTY_CONVERSATION;
  }
}

/**
 * Keeps the conversation for this tab: its last 12 entries. Nothing happens
 * where storage is blocked or full.
 *
 * @param {string} key
 * @param {{ entries: object[], turns: number, nextId: number }} conversation
 */
export function writeConversation(key, conversation) {
  try {
    if (conversation.entries.length === 0 && conversation.turns === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        ...conversation,
        entries: conversation.entries.slice(-REVISE_CONVERSATION_MAX)
      })
    );
  } catch {
    // The conversation stays on the page; it is just not kept for a reload.
  }
}
