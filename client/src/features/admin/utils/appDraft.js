// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The draft of a new app, as the create page holds it between its two
 * screens: one function per way to start, and the step from a draft to the
 * body of the create request (`POST /api/admin/apps`).
 *
 * A draft is an app configuration and nothing else: the page keeps its own
 * state (which start, the description, what the author ticked) beside it, so
 * no key has to be stripped before the request.
 *
 * Languages of the stored app, by start:
 *
 * - empty, link, AI draft: one, the content language;
 * - template: one, the content language ({@link draftFromTemplate});
 * - copy: every language of the source, minus the other languages of a text
 *   the author changed ({@link dropOtherLanguages}).
 *
 * Pure, and free of any assumption about who creates the app or where the
 * page lives: no request, no path, no permission. No function modifies its
 * argument.
 *
 * @module features/admin/utils/appDraft
 */

import {
  DEFAULT_APP_CATEGORY,
  DEFAULT_APP_COLOR,
  DEFAULT_APP_ICON,
  UI_CREATES_PUBLISHED,
  cleanAppForSave,
  newAppDefaults,
  primaryLanguageOf
} from '../../../../../shared/appDefaults.js';
import { appIdProblem, slugifyAppId, uniqueAppId } from '../../../../../shared/appId.js';
import { removeVariables } from '../../../../../shared/appPlaceholders.js';

/** The texts of a copy that the Essentials screen edits. */
const ESSENTIAL_TEXT_FIELDS = ['name', 'description', 'system'];

/** What a copy does not take over: the lineage nothing reads, and the list position. */
const NOT_COPIED_KEYS = [
  'parentId',
  'inheritanceLevel',
  'overriddenFields',
  'allowInheritance',
  'order'
];

/** The sandbox of an embedded website unless the author changes it in the editor. */
const DEFAULT_IFRAME_SANDBOX = ['allow-scripts', 'allow-same-origin', 'allow-forms'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** `isTaken` as a function: the caller's own, or one over the IDs it listed. */
function takenPredicate(isTaken) {
  if (typeof isTaken === 'function') return isTaken;
  if (isTaken && typeof isTaken[Symbol.iterator] === 'function') {
    const ids = new Set([...isTaken].map(id => String(id).toLowerCase()));
    return id => ids.has(id);
  }
  return () => false;
}

/**
 * One language of a localized text, stored under `language`: the text of
 * that language, else the English text, else the first one. `undefined` when
 * no language has text.
 */
function inOneLanguage(value, language) {
  if (hasText(value)) return { [language]: value };
  if (!isPlainObject(value)) return undefined;
  const text = [value[language], value.en, ...Object.values(value)].find(hasText);
  return text === undefined ? undefined : { [language]: text };
}

/** `source` with each of `fields` reduced to one language; a field without text is left out. */
function withOneLanguage(source, fields, language) {
  const result = { ...source };
  for (const field of fields) {
    if (!(field in result)) continue;
    const text = inOneLanguage(result[field], language);
    if (text) {
      result[field] = text;
    } else {
      delete result[field];
    }
  }
  return result;
}

/**
 * The language a new app's texts are written and stored in: the base language
 * of the UI (`de` for `de-DE`). Where the UI language is not a language tag,
 * the platform's default language, and `en` as the last resort.
 *
 * The browser locale is usually regional (`en-US`), while apps store their
 * texts under base languages. A name stored under `en-US` is missing for
 * every user whose language is `en`.
 *
 * @param {string} [uiLanguage] - A language tag such as `i18n.language`.
 * @param {string} [platformDefault] - `platform.defaultLanguage`.
 * @returns {string}
 *
 * @example
 * contentLanguage('de-DE'); // → 'de'
 * contentLanguage(undefined, 'de'); // → 'de'
 */
export function contentLanguage(uiLanguage, platformDefault) {
  return primaryLanguageOf(null, uiLanguage, platformDefault);
}

/**
 * The categories an app can be put in: the apps list's categories from
 * `ui.json` (`appsList.categories.list`) without the "all" filter entry — the
 * list the app editor offers. A category the app already has that is not in
 * the list is kept as the last entry, so selecting the field never drops it.
 *
 * @param {Object|null|undefined} uiConfig - The UI configuration.
 * @param {string} [currentCategory] - The app's category.
 * @returns {Array<{id: string, name: Object<string, string>|string}>}
 *
 * @example
 * appCategoryOptions({ appsList: { categories: { list: [{ id: 'all' }, { id: 'writing', name: { en: 'Writing' } }] } } });
 * // → [{ id: 'writing', name: { en: 'Writing' } }]
 */
export function appCategoryOptions(uiConfig, currentCategory) {
  const list = uiConfig?.appsList?.categories?.list;
  const options = (Array.isArray(list) ? list : [])
    .filter(category => category?.id && category.id !== 'all')
    .map(category => ({ id: category.id, name: category.name || category.id }));
  if (currentCategory && !options.some(category => category.id === currentCategory)) {
    options.push({ id: currentCategory, name: currentCategory });
  }
  return options;
}

/**
 * The draft of "Start empty": the defaults of a new chat app, with empty
 * texts in the content language and no ID.
 *
 * @param {string} language - The content language ({@link contentLanguage}).
 * @returns {object}
 */
export function draftFromBlank(language) {
  return newAppDefaults(language);
}

/** An input field of a template in one language. */
function variableInOneLanguage(variable, language) {
  if (!isPlainObject(variable)) return variable;
  const result = withOneLanguage(variable, ['description', 'placeholder'], language);
  result.label = inOneLanguage(variable.label, language) || { [language]: '' };
  if (isPlainObject(variable.defaultValue)) {
    const { defaultValue } = variable;
    const value = [defaultValue[language], defaultValue.en, ...Object.values(defaultValue)].find(
      text => typeof text === 'string'
    );
    if (value === undefined) {
      delete result.defaultValue;
    } else {
      result.defaultValue = { [language]: value };
    }
  }
  if (Array.isArray(variable.predefinedValues)) {
    result.predefinedValues = variable.predefinedValues.map(option =>
      isPlainObject(option)
        ? { ...option, label: inOneLanguage(option.label, language) || { [language]: '' } }
        : option
    );
  }
  return result;
}

/**
 * The draft of a template start: the defaults of a new app plus the
 * template's content, in the content language only. Name, short description,
 * instructions, message template, input placeholder, the labels and options
 * of input fields and the conversation starters keep one language each. For a
 * content language the template does not carry, the English text is the
 * starting text and is stored under the content language.
 *
 * The ID is derived from the name and is free. The name gets no "(copy)".
 *
 * @param {object} template - An item of `GET /api/admin/app-templates`
 *   (`{ id, name, description, icon, color, category, app }`; what `app`
 *   carries wins over the item's own fields), or a template's content itself.
 * @param {object} options
 * @param {string} options.language - The content language ({@link contentLanguage}).
 * @param {((id: string) => boolean)|Iterable<string>} [options.isTaken] -
 *   Whether an app ID is in use, or the IDs in use.
 * @returns {object}
 */
export function draftFromTemplate(template, { language, isTaken } = {}) {
  const lang = contentLanguage(language);
  const item = isPlainObject(template) ? template : {};
  const source = clone(isPlainObject(item.app) ? { ...item, ...item.app } : item);
  const draft = newAppDefaults(lang);

  for (const field of ['icon', 'color', 'category']) {
    if (hasText(source[field])) draft[field] = source[field];
  }
  if (typeof source.allowEmptyContent === 'boolean') {
    draft.allowEmptyContent = source.allowEmptyContent;
  }

  for (const field of ESSENTIAL_TEXT_FIELDS) {
    draft[field] = inOneLanguage(source[field], lang) || { [lang]: '' };
  }
  for (const field of ['prompt', 'messagePlaceholder']) {
    const text = inOneLanguage(source[field], lang);
    if (text) draft[field] = text;
  }

  if (Array.isArray(source.variables)) {
    draft.variables = source.variables.map(variable => variableInOneLanguage(variable, lang));
  }
  if (Array.isArray(source.starterPrompts)) {
    draft.starterPrompts = source.starterPrompts.map(starter =>
      isPlainObject(starter)
        ? withOneLanguage(starter, ['title', 'message', 'description'], lang)
        : starter
    );
  }

  draft.id = uniqueAppId(slugifyAppId(draft.name[lang]) || slugifyAppId(item.id), isTaken);
  return draft;
}

/**
 * The draft of a copy ("Duplicate", "Copy an existing app"): everything the
 * source has, in every language, except its lineage (`parentId`,
 * `inheritanceLevel`, `overriddenFields`, `allowInheritance`) and its
 * position in the list. Every language of the name gets the "(copy)" label,
 * and the app is not published.
 *
 * The ID is a free one derived from the copy's name, like the ID of every
 * other start, so it does not jump when the author starts typing in the name
 * field. The name is taken in the language the Essentials screen edits
 * (`primaryLanguageOf(app, language)`). A name without a usable character
 * falls back to the source's ID.
 *
 * @param {object} app - The source, as `GET /api/admin/apps/{id}` returns it.
 * @param {object} options
 * @param {((id: string) => boolean)|Iterable<string>} [options.isTaken] -
 *   Whether an app ID is in use, or the IDs in use. The source's own ID
 *   always counts as taken.
 * @param {((name: string, language: string) => string)|string} [options.copyLabel] -
 *   Turns a name into the copy's name, for example
 *   `name => t('admin.apps.create.copy.nameSuffix', { name })`; or a suffix
 *   such as `(copy)`, appended after a space. Without it the name stays.
 * @param {string} [options.language] - The UI language, to pick the name the
 *   ID is derived from.
 * @returns {object}
 */
export function draftFromExistingApp(app, { isTaken, copyLabel, language } = {}) {
  const draft = clone(isPlainObject(app) ? app : {});
  for (const key of NOT_COPIED_KEYS) delete draft[key];

  const copyName = (name, nameLanguage) => {
    if (typeof copyLabel === 'function') return String(copyLabel(name, nameLanguage));
    if (hasText(copyLabel)) return `${name} ${copyLabel.trim()}`;
    return name;
  };
  if (hasText(draft.name)) {
    draft.name = copyName(draft.name, undefined);
  } else if (isPlainObject(draft.name)) {
    draft.name = Object.fromEntries(
      Object.entries(draft.name).map(([nameLanguage, name]) => [
        nameLanguage,
        hasText(name) ? copyName(name, nameLanguage) : name
      ])
    );
  }

  draft.enabled = UI_CREATES_PUBLISHED;

  const sourceId = typeof draft.id === 'string' ? draft.id.toLowerCase() : '';
  const name = isPlainObject(draft.name)
    ? draft.name[primaryLanguageOf(draft, language)]
    : draft.name;
  const taken = takenPredicate(isTaken);
  draft.id = uniqueAppId(
    slugifyAppId(name) || slugifyAppId(sourceId),
    id => id === sourceId || taken(id)
  );
  return draft;
}

/**
 * The draft of the AI start, from the answer of
 * `POST /api/admin/apps/_generate`. The server's app is taken as it is; the
 * model's text never reaches this function. What the model proposed comes as
 * suggestions, and only the suggestions the author ticked are added:
 *
 * - `webSearch: true` switches web search on, if the answer suggested it;
 * - `integrationIds` binds the suggested connected systems with these IDs,
 *   each with the actions the server listed (none listed: the whole system);
 * - `inputFields: false` removes the input fields and the lines of the
 *   message template that use them. Sending without a message is then
 *   switched off again: the server allows it only because of the fields.
 *
 * Like every start, the draft is published or not as `UI_CREATES_PUBLISHED` says.
 *
 * @param {{ app: object, suggestions?: { websearch?: boolean, integrations?: Array<{ id: string, actions?: string[] }> } }} result
 * @param {object} [ticked]
 * @param {boolean} [ticked.webSearch=false]
 * @param {string[]} [ticked.integrationIds=[]]
 * @param {boolean} [ticked.inputFields=true]
 * @returns {object}
 */
export function draftFromGenerated(
  result,
  { webSearch = false, integrationIds = [], inputFields = true } = {}
) {
  let draft = clone(result?.app) || {};
  // Nothing is bound unless the author ticked it, whatever the app carries.
  delete draft.websearch;
  delete draft.integrations;

  if (inputFields === false) {
    draft = { ...removeVariables(draft), allowEmptyContent: false };
  }

  const suggestions = isPlainObject(result?.suggestions) ? result.suggestions : {};
  if (webSearch === true && suggestions.websearch === true) {
    draft.websearch = { enabled: true };
  }

  const offered = Array.isArray(suggestions.integrations) ? suggestions.integrations : [];
  const wanted = new Set(Array.isArray(integrationIds) ? integrationIds : []);
  const bindings = {};
  for (const suggestion of offered) {
    if (!isPlainObject(suggestion) || !wanted.has(suggestion.id)) continue;
    const actions = Array.isArray(suggestion.actions)
      ? suggestion.actions.filter(action => typeof action === 'string')
      : [];
    bindings[suggestion.id] = actions.length > 0 ? { actions } : {};
  }
  if (Object.keys(bindings).length > 0) draft.integrations = bindings;

  draft.enabled = UI_CREATES_PUBLISHED;
  return draft;
}

/**
 * The draft of a link app: a link to a website (`mode: 'redirect'`) or a
 * website shown inside iHub (`mode: 'iframe'`). It has no instructions and
 * none of the chat settings.
 *
 * @param {object} options
 * @param {string} options.language - The content language.
 * @param {'redirect'|'iframe'} options.mode
 * @param {string} [options.url] - The website address.
 * @returns {object}
 */
export function draftForLink({ language, mode, url } = {}) {
  const lang = contentLanguage(language);
  const address = typeof url === 'string' ? url.trim() : '';
  const draft = {
    id: '',
    type: mode === 'iframe' ? 'iframe' : 'redirect',
    order: 0,
    name: { [lang]: '' },
    description: { [lang]: '' },
    color: DEFAULT_APP_COLOR,
    icon: DEFAULT_APP_ICON,
    category: DEFAULT_APP_CATEGORY,
    enabled: UI_CREATES_PUBLISHED
  };
  if (draft.type === 'iframe') {
    draft.iframeConfig = {
      url: address,
      allowFullscreen: true,
      sandbox: [...DEFAULT_IFRAME_SANDBOX]
    };
  } else {
    draft.redirectConfig = { url: address, openInNewTab: true, showWarning: true };
  }
  return draft;
}

/**
 * For a copy, before it is created: each of name, short description and
 * instructions that the author changed keeps only the language the author
 * edited. The runtime picks a text by the user's language first, so an old
 * version in another language would be shown to those users instead of the
 * new text. A text the author did not change keeps all its languages.
 *
 * @param {object} draft
 * @param {string[]} editedFields - Of `name`, `description`, `system`; other
 *   names are ignored.
 * @param {string} [language] - The language the Essentials screen edits:
 *   `primaryLanguageOf(draft, uiLanguage, platformDefault)`. Pass it wherever
 *   the UI language is known. Without it, it is `primaryLanguageOf(draft)`,
 *   which is right only when the UI language has no say.
 * @returns {object} A new draft; `draft` is not modified.
 *
 * @example
 * dropOtherLanguages({ name: { en: 'A', de: 'B' }, system: { en: 'x', de: 'y' } }, ['system'], 'de');
 * // → { name: { en: 'A', de: 'B' }, system: { de: 'y' } }
 */
export function dropOtherLanguages(draft, editedFields, language) {
  const edited = Array.isArray(editedFields) ? editedFields : [];
  const kept = hasText(language) ? language : primaryLanguageOf(draft);
  const result = { ...draft };
  for (const field of ESSENTIAL_TEXT_FIELDS) {
    if (!edited.includes(field)) continue;
    const text = result[field];
    if (!isPlainObject(text) || Object.keys(text).length < 2) continue;
    // Without text in that language nothing was rewritten; the other versions stay.
    if (hasText(text[kept])) result[field] = { [kept]: text[kept] };
  }
  return result;
}

/**
 * The body of `POST /api/admin/apps` for a draft: the draft cleaned for
 * saving, with a checked ID.
 *
 * @param {object} draft
 * @returns {object}
 * @throws {Error} With `code: 'APP_ID_INVALID'`, `field: 'id'` and `problem`
 *   (`required`, `tooLong`, `format` or `reserved`) when the ID cannot be the
 *   ID of a new app. The page checks the ID before; this is the last guard
 *   against an ID that a route shadows.
 */
export function buildCreatePayload(draft) {
  const payload = cleanAppForSave({
    ...draft,
    id: typeof draft?.id === 'string' ? draft.id.trim() : ''
  });
  const problem = appIdProblem(payload.id);
  if (problem) {
    const error = new Error(`"${payload.id}" cannot be used as an app ID (${problem})`);
    error.code = 'APP_ID_INVALID';
    error.field = 'id';
    error.problem = problem;
    throw error;
  }
  return payload;
}
