// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The engine of the conversation that changes an app (issue #3898,
 * `POST /api/admin/apps/_revise`, `POST /api/apps/_revise`).
 *
 * One turn is one model call. It gets the app's current content, the
 * conversation so far and the author's latest message, and answers with one
 * question, one change or one message. Nothing is stored: the client merges a
 * change into its form and saves it through the editor's normal save.
 *
 * The model influences wording and the content keys of the target, nothing
 * else. A change goes through the same allow-list and sanitiser as a draft
 * ({@link sanitizeGeneratedApp}), only the keys the model returned and the
 * sanitiser changed enter `patch`, and the patched app is checked against the
 * schema of its target. Web search and integrations come back as
 * `suggestions`, filtered to what the caller may use, and never enter `patch`.
 *
 * Design: concepts/app-builder-rework-2026-11/04-chat-builder-implementation-plan.md,
 * section 2.3 (the steps below are numbered as there).
 *
 * @module services/appRevision
 */

import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { ServiceError } from '../utils/ServiceError.js';
import { getLocalizedString } from '../utils/localize.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { userAppContentSchema } from '../validators/userAppSchema.js';
import defaultLlmClient from './loop/LLMClient.js';
import {
  GENERATOR_MAX_TOKENS,
  GENERATOR_TIMEOUT_MS,
  appCategoryIds,
  baseLanguage,
  installationsFor,
  integrationsBlock,
  parseGeneratedAnswer,
  pickDraftModel,
  sanitizeGeneratedApp,
  searchFor
} from './appGenerator.js';
import { buildRevisionMessages } from './appGeneratorBrief.js';
import { newAppDefaults } from '../../shared/appDefaults.js';
import {
  REVISE_CHOICES_MAX,
  REVISE_CONTENT_LIMITS,
  REVISE_CHOICE_MAX,
  REVISE_LOCALIZED_KEYS,
  REVISE_QUESTION_CAP,
  REVISE_SYSTEM_MAX,
  REVISE_TEXT_MAX,
  REVISE_WARNINGS,
  appRevisionKeys,
  applyRevisionPatch,
  revisionLanguageKey
} from '../../shared/appRevision.js';
import { stripHiddenCharacters } from '../../shared/visibleText.js';

const COMPONENT = 'AppRevision';

/** The keys of a required text: an empty proposal for one is ignored, never applied. */
const REQUIRED_TEXT_KEYS = new Set(['name', 'description', 'system']);

/**
 * What the sanitiser gets for a required text the app does not have yet, so
 * that an app without a name or instructions can still be revised. It is the
 * same in both runs of the sanitiser, so it never shows up as a change.
 */
const MISSING_TEXT = 'revision-placeholder';

/** The ID the schema check gives an admin app: the request carries no ID, and none is read. */
const CHECK_APP_ID = 'app-revision-check';

/** The keys of a model's change read as suggestions, never as content. */
const SUGGESTION_KEYS = ['websearch', 'integrations'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Every string of a JSON value without hidden characters. */
function visibleDeep(value) {
  if (typeof value === 'string') return stripHiddenCharacters(value);
  if (Array.isArray(value)) return value.map(visibleDeep);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, visibleDeep(entry)])
    );
  }
  return value;
}

/** Two JSON values are equal. Both come from the sanitiser, so their keys are in one order. */
function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The value as a localized object: itself, or `{}` for a plain string or nothing. */
function localizedObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

/**
 * The text of a stored value in `language`: the language itself, its base,
 * English, then any language with text. A plain string is its own text.
 * Hidden characters are removed; the text is trimmed.
 *
 * @param {unknown} value - A localized object or a string.
 * @param {string} language
 * @returns {string}
 */
export function textIn(value, language) {
  if (typeof value === 'string') return stripHiddenCharacters(value).trim();
  if (!isPlainObject(value)) return '';
  const candidates = [
    value[language],
    value[baseLanguage(language)],
    value.en,
    ...Object.values(value)
  ];
  const text = candidates
    .map(candidate =>
      typeof candidate === 'string' ? stripHiddenCharacters(candidate).trim() : ''
    )
    .find(Boolean);
  return text || '';
}

/** The localized text keys a revision reads, with the limit each one has in `REVISE_CONTENT_LIMITS`. */
const LIMITED_TEXT_KEYS = ['name', 'description', 'system', 'prompt', 'messagePlaceholder'];

/** The keys a revision reads as one short string. */
const SHORT_VALUE_KEYS = ['category', 'color', 'icon'];

/** `{ field, max, length }` when `length` is over `max`, else `null`. */
function over(field, length, max) {
  return length > max ? { field, max, length } : null;
}

/**
 * The length of a value the model gets as it is (a field's `name` and `type`,
 * an option's `value`). Anything but a string, number or boolean is never
 * passed on as it is, so it counts as too long.
 */
function rawLength(value) {
  if (value === undefined || value === null) return 0;
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value).length;
  return Infinity;
}

/** The plain-object entries of a list, or none. */
function entriesOf(list) {
  return Array.isArray(list) ? list.filter(isPlainObject) : [];
}

/** The texts and short values of a draft over their limit; see {@link overLimit}. */
function textsOverLimit(draft, language, limits) {
  for (const key of LIMITED_TEXT_KEYS) {
    const found = over(key, textIn(draft[key], language).length, limits[key]);
    if (found) return found;
  }
  for (const key of SHORT_VALUE_KEYS) {
    const value = draft[key];
    const found = typeof value === 'string' ? over(key, value.length, limits.shortValue) : null;
    if (found) return found;
  }
  return null;
}

/** The input fields of a draft over their limits; see {@link overLimit}. */
function variablesOverLimit(draft, language, limits) {
  if (!Array.isArray(draft.variables)) return null;
  const field = 'variables';
  const textLength = value => textIn(value, language).length;
  const variables = entriesOf(draft.variables);
  const checks = [over(field, variables.length, limits.variables)];
  for (const variable of variables) {
    const options = entriesOf(variable.predefinedValues);
    checks.push(
      over(field, rawLength(variable.name), limits.variableName),
      over(field, rawLength(variable.type), limits.shortValue),
      over(field, textLength(variable.label), limits.variableLabel),
      over(field, textLength(variable.defaultValue), limits.variableDefault),
      over(field, options.length, limits.options),
      ...options.flatMap(option => [
        over(field, rawLength(option.value), limits.optionValue),
        over(field, textLength(option.label), limits.optionLabel)
      ])
    );
  }
  return checks.find(Boolean) || null;
}

/** The conversation starters of a draft over their limits; see {@link overLimit}. */
function startersOverLimit(draft, language, limits) {
  if (!Array.isArray(draft.starterPrompts)) return null;
  const field = 'starterPrompts';
  const starters = entriesOf(draft.starterPrompts);
  const checks = [
    over(field, starters.length, limits.starterPrompts),
    ...starters.flatMap(starter => [
      over(field, textIn(starter.title, language).length, limits.starterTitle),
      over(field, textIn(starter.message, language).length, limits.starterMessage)
    ])
  ];
  return checks.find(Boolean) || null;
}

/**
 * The first content key of a draft that is over its limit, as the model would
 * see it: the text in `language`, the number of entries of a list, the length
 * of a short value. `null` when everything fits.
 *
 * @param {object} draft
 * @param {string} language
 * @param {'admin'|'personal'} target
 * @returns {{ field: string, max: number, length: number }|null}
 */
function overLimit(draft, language, target) {
  const limits = REVISE_CONTENT_LIMITS[target] || REVISE_CONTENT_LIMITS.admin;
  return (
    textsOverLimit(draft, language, limits) ||
    variablesOverLimit(draft, language, limits) ||
    startersOverLimit(draft, language, limits)
  );
}

/**
 * Refuse a revision whose content is more than a turn can revise
 * (`REVISE_CONTENT_LIMITS` of the target). The instructions: the model would
 * have to write them out in full, and a cut-off answer would lose their end.
 * Every other key: the content of one model call stays bounded. Only the
 * content keys of the target are read, each as the model would get it (the
 * text in `language`).
 *
 * Called by the routes before the revise limit counts the request, and again
 * by {@link reviseApp}.
 *
 * @param {object} draft - The `draft` of the request.
 * @param {string} language - The language of the revision.
 * @param {'admin'|'personal'} [target='admin']
 * @throws {ServiceError} `APP_REVISE_TOO_LONG` (400) with `details: { field, max }`;
 *   `field` is the content key (`system`, `variables`, …)
 */
export function assertRevisable(draft, language, target = 'admin') {
  if (!isPlainObject(draft)) return;
  const keys = appRevisionKeys(target);
  const content = Object.fromEntries(Object.entries(draft).filter(([key]) => keys.includes(key)));
  const found = overLimit(content, language, target);
  if (!found) return;
  const { field, max } = found;
  const message =
    field === 'system'
      ? `The instructions have ${found.length} characters; a conversation can change at most ${REVISE_SYSTEM_MAX}`
      : `"${field}" is longer than a conversation can change (at most ${max})`;
  throw new ServiceError('APP_REVISE_TOO_LONG', message, { details: { field, max } });
}

/**
 * How many questions the builder asked since its last change: builder entries
 * with `kind: 'question'` after the last one with `kind: 'change'`.
 *
 * @param {Array<{ role: string, kind?: string }>} conversation
 * @returns {number}
 */
export function questionsSinceLastChange(conversation) {
  let count = 0;
  for (const entry of conversation) {
    if (entry?.role !== 'builder') continue;
    if (entry.kind === 'change') count = 0;
    else if (entry.kind === 'question') count += 1;
  }
  return count;
}

/** An input field as the model sees it: its texts in `language`. */
function variableForModel(variable, language) {
  const defaultValue = textIn(variable.defaultValue, language);
  const options = Array.isArray(variable.predefinedValues) ? variable.predefinedValues : [];
  return {
    name: variable.name,
    label: textIn(variable.label, language) || variable.name,
    type: variable.type,
    ...(variable.required === true ? { required: true } : {}),
    ...(defaultValue ? { defaultValue } : {}),
    ...(options.length > 0
      ? {
          predefinedValues: options.filter(isPlainObject).map(option => ({
            value: option.value,
            label: textIn(option.label, language) || option.value
          }))
        }
      : {})
  };
}

/** A conversation starter as the model sees it: its texts in `language`. */
function starterForModel(starter, language) {
  return { title: textIn(starter.title, language), message: textIn(starter.message, language) };
}

/** One key of the content the model sees, or `undefined` to leave it out. */
function valueForModel(key, value, language) {
  if (REVISE_LOCALIZED_KEYS.includes(key)) return textIn(value, language) || undefined;
  if (key === 'variables') {
    return Array.isArray(value)
      ? value.filter(isPlainObject).map(variable => variableForModel(variable, language))
      : undefined;
  }
  if (key === 'starterPrompts') {
    return Array.isArray(value)
      ? value.filter(isPlainObject).map(starter => starterForModel(starter, language))
      : undefined;
  }
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Step 2: the content the model sees. Only the target's keys, each text in
 * `language` (hidden characters removed), input fields and conversation
 * starters with their texts in that language. Keys without a value are left
 * out.
 *
 * @param {object} source - The target's keys of the draft, hidden characters removed.
 * @param {readonly string[]} keys
 * @param {string} language
 * @returns {object}
 */
function contentForModel(source, keys, language) {
  const content = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const forModel = valueForModel(key, value, language);
    if (forModel !== undefined) content[key] = forModel;
  }
  return content;
}

/**
 * Whether the app has text in a language this revision does not write: a key
 * of its name, description or instructions with text other than the one the
 * revision reads and writes there ({@link revisionLanguageKey}). `de-DE` text
 * revised in `de-DE` is the revision's own language, not another one.
 *
 * @param {object} source
 * @param {string} language - The language of the revision.
 * @returns {boolean}
 */
function hasOtherLanguages(source, language) {
  for (const key of ['name', 'description', 'system']) {
    const value = source[key];
    if (!isPlainObject(value)) continue;
    const own = revisionLanguageKey(value, language);
    for (const [other, text] of Object.entries(value)) {
      if (other !== own && typeof text === 'string' && text.trim()) return true;
    }
  }
  return false;
}

/** A plain sentence for the author: hidden characters removed, white space collapsed, cut. */
function plainText(value, max = REVISE_TEXT_MAX) {
  if (typeof value !== 'string') return '';
  return stripHiddenCharacters(value).replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** The error of an answer that cannot become a reply. */
function invalidAnswer(reason, message) {
  return new ServiceError('APP_GENERATOR_INVALID_ANSWER', message, { details: { reason } });
}

/**
 * Step 6: the kind of reply the model gave: its `reply` when that is known,
 * else what the answer holds (a `change` object, a `question`), else a message.
 */
function replyKind(answer) {
  if (['question', 'change', 'message'].includes(answer.reply)) return answer.reply;
  if (isPlainObject(answer.change)) return 'change';
  if (isPlainObject(answer.question) || typeof answer.question === 'string') return 'question';
  return 'message';
}

/** The question of an answer: its text and at most six distinct, short choices. */
function questionOf(answer) {
  const raw = isPlainObject(answer.question) ? answer.question : { text: answer.question };
  const choices = [];
  for (const choice of Array.isArray(raw.choices) ? raw.choices : []) {
    const text = plainText(typeof choice === 'number' ? String(choice) : choice, REVISE_CHOICE_MAX);
    if (text && !choices.includes(text)) choices.push(text);
    if (choices.length >= REVISE_CHOICES_MAX) break;
  }
  return { text: plainText(raw.text), choices, allowOther: true };
}

/**
 * The value the sanitiser reads for a key: the model's proposal for the keys
 * it returned, else the current content. A required text the app lacks gets a
 * placeholder ({@link MISSING_TEXT}).
 */
function sanitiserInput(current, proposal) {
  const input = { ...current, ...proposal };
  for (const key of REQUIRED_TEXT_KEYS) {
    if (!input[key]) input[key] = MISSING_TEXT;
  }
  return input;
}

/** The variable of the draft with this name, or undefined. */
function variableNamed(variables, name) {
  return (Array.isArray(variables) ? variables : []).find(
    variable => isPlainObject(variable) && variable.name === name
  );
}

/**
 * A localized value with the revised text of `lang` (the sanitiser's key)
 * written under the key the revision reads ({@link revisionLanguageKey}): the
 * value's other languages stay.
 *
 * @param {unknown} before - The value as the draft holds it.
 * @param {string} text - The revised text.
 * @param {string} language - The language of the revision.
 * @returns {object}
 */
function withText(before, text, language) {
  return { ...localizedObject(before), [revisionLanguageKey(before, language)]: text };
}

/** The keys of an input field the sanitiser writes; every other key is the author's own. */
const SANITISED_VARIABLE_KEYS = [
  'name',
  'label',
  'type',
  'required',
  'defaultValue',
  'predefinedValues'
];

/** The keys of a conversation starter the sanitiser writes; every other key is the author's own. */
const SANITISED_STARTER_KEYS = ['title', 'message'];

/** Keys never copied from an entry, whatever it holds. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * An entry of the draft with the sanitiser's keys replaced by `written`. The
 * keys the sanitiser does not write (a field's `description` and
 * `placeholder`, a starter's `description`, `variables` and `autoSend`, and
 * any other key the author's app has there) stay as the draft holds them, in
 * their place; a sanitiser key missing from `written` is removed. Those keys
 * come from the draft only, never from the model: the sanitiser reads none of
 * them. A new entry (no `before`) is `written` alone.
 *
 * @param {unknown} before - The entry of the draft it replaces, or nothing.
 * @param {object} written - The sanitiser's keys of the new entry.
 * @param {string[]} sanitisedKeys - The keys the sanitiser writes.
 * @returns {object}
 */
function overEntry(before, written, sanitisedKeys) {
  const result = {};
  if (isPlainObject(before)) {
    for (const [key, value] of Object.entries(before)) {
      if (UNSAFE_KEYS.has(key)) continue;
      if (!sanitisedKeys.includes(key) || Object.hasOwn(written, key)) result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(written)) result[key] = value;
  return result;
}

/**
 * The default text a revised field writes in `language`: the draft's own text
 * when it means the same default as the sanitiser's, else the sanitiser's. The
 * sanitiser writes the default of a field with options as that option's label
 * (`Professional`); a shipped app may name it by value (`professional`) or in
 * another case, and a change of some other field must not rewrite it.
 *
 * @param {object|undefined} before - The field of the draft with this name.
 * @param {object} variable - The sanitised field; its texts are under `lang`.
 * @param {string} lang - The sanitiser's language key.
 * @param {string} language - The language of the revision.
 * @returns {string}
 */
function defaultTextToWrite(before, variable, lang, language) {
  const proposed = variable.defaultValue[lang];
  const own = isPlainObject(before?.defaultValue)
    ? before.defaultValue[revisionLanguageKey(before.defaultValue, language)]
    : undefined;
  if (typeof own !== 'string') return proposed;
  const old = stripHiddenCharacters(own).trim();
  if (old === proposed) return own;
  const option = (variable.predefinedValues || []).find(entry => entry.label[lang] === proposed);
  if (!option) return proposed;
  const folded = old.toLowerCase();
  const names = [option.value, option.label[lang]];
  return names.some(name => name === old || name.toLowerCase() === folded) ? own : proposed;
}

/**
 * Step 8 for `variables`: the sanitised fields (texts in `lang` only) with the
 * other languages of a field whose `name` stayed: its label, default and the
 * labels of options whose `value` stayed. A revised text goes under the key it
 * was read from (`language`). Each field starts from the field of the draft
 * with that name, so the keys the sanitiser does not write (`description`,
 * `placeholder`, …) stay; a new field has none of them. `required` stays
 * absent on a field of the draft that had none and is still optional. A field
 * the model wrote back as it was (the same in `unchanged`) is the draft's own.
 * With `keepDraft` false every field is built from the sanitiser's keys alone
 * (see {@link changeReply}).
 */
function variablesWithLanguages(sanitized, currentVariables, lang, language, options) {
  const { unchanged, keepDraft } = options;
  return sanitized.map(variable => {
    const before = variableNamed(currentVariables, variable.name);
    if (keepDraft && before && sameValue(variableNamed(unchanged, variable.name), variable)) {
      return before;
    }
    const result = {
      name: variable.name,
      label: withText(before?.label, variable.label[lang], language),
      type: variable.type
    };
    // A field of the draft without `required` keeps it absent while it stays optional.
    if (
      !keepDraft ||
      variable.required ||
      !isPlainObject(before) ||
      Object.hasOwn(before, 'required')
    ) {
      result.required = variable.required;
    }
    const otherDefaults = localizedObject(before?.defaultValue);
    const ownDefaultKey = revisionLanguageKey(before?.defaultValue, language);
    // An empty default the draft holds in this language was empty before and stays: no change.
    if (textIn(otherDefaults[ownDefaultKey], language)) delete otherDefaults[ownDefaultKey];
    if (variable.defaultValue) {
      const text = defaultTextToWrite(before, variable, lang, language);
      result.defaultValue = withText(before?.defaultValue, text, language);
    } else if (Object.keys(otherDefaults).length > 0 && before?.type === variable.type) {
      result.defaultValue = otherDefaults;
    }
    if (variable.predefinedValues) {
      const beforeOptions = Array.isArray(before?.predefinedValues) ? before.predefinedValues : [];
      result.predefinedValues = variable.predefinedValues.map(option => {
        const known = beforeOptions.find(
          candidate => isPlainObject(candidate) && candidate.value === option.value
        );
        return {
          value: option.value,
          label: withText(known?.label, option.label[lang], language)
        };
      });
    }
    return overEntry(keepDraft ? before : undefined, result, SANITISED_VARIABLE_KEYS);
  });
}

/**
 * Step 8 for `starterPrompts`: the sanitised starters with the other languages
 * of the starter they replace: the one whose title or message in `lang` is the
 * same, else, when the number of starters stayed, the one at the same place.
 * Each starter starts from the one it replaces, so the keys the sanitiser does
 * not write (`description`, `variables`, `autoSend`, …) stay; a starter that
 * replaces none has none of them. A starter the model wrote back as it was is
 * the draft's own. With `keepDraft` false every starter is built from the
 * sanitiser's keys alone (see {@link changeReply}).
 */
function startersWithLanguages(sanitized, currentStarters, lang, language, keepDraft) {
  const before = (Array.isArray(currentStarters) ? currentStarters : []).filter(isPlainObject);
  return sanitized.map((starter, index) => {
    const same =
      keepDraft &&
      before.find(
        candidate =>
          textIn(candidate.title, language) === starter.title[lang] &&
          textIn(candidate.message, language) === starter.message[lang]
      );
    if (same) return same;
    const match =
      before.find(
        candidate =>
          textIn(candidate.title, language) === starter.title[lang] ||
          textIn(candidate.message, language) === starter.message[lang]
      ) || (before.length === sanitized.length ? before[index] : undefined);
    const written = {
      title: withText(match?.title, starter.title[lang], language),
      message: withText(match?.message, starter.message[lang], language)
    };
    return overEntry(keepDraft ? match : undefined, written, SANITISED_STARTER_KEYS);
  });
}

/**
 * Step 8: the whole new value of a changed key. A localized text keeps its
 * other languages, and the new text goes under the key it was read from
 * ({@link revisionLanguageKey}: `de-DE` for an app kept under `de-DE`); an
 * empty optional text removes that key, and the whole key (`null`) when no
 * language is left.
 *
 * @param {string} key
 * @param {object} sanitizedApp - The sanitiser's app; its texts are under `lang`.
 * @param {object} source - The draft's content keys.
 * @param {string} lang - The base language, the sanitiser's key.
 * @param {string} language - The language of the revision as requested.
 * @param {object} draftOptions
 * @param {object} draftOptions.unchangedApp - The sanitiser's app of the draft without the
 *   proposal: an input field that is the same there and in `sanitizedApp` is the draft's own.
 * @param {boolean} draftOptions.keepDraft - Keep the draft's own entries and keys in
 *   `variables` and `starterPrompts`; `false` builds them from the sanitiser alone.
 * @returns {unknown}
 */
function patchValue(key, sanitizedApp, source, lang, language, { unchangedApp, keepDraft }) {
  if (REVISE_LOCALIZED_KEYS.includes(key)) {
    const value = localizedObject(source[key]);
    const own = revisionLanguageKey(source[key], language);
    const text = sanitizedApp[key]?.[lang];
    if (text) value[own] = text;
    else delete value[own];
    return Object.keys(value).length > 0 ? value : null;
  }
  if (key === 'variables') {
    return variablesWithLanguages(sanitizedApp.variables, source.variables, lang, language, {
      unchanged: unchangedApp?.variables,
      keepDraft
    });
  }
  if (key === 'starterPrompts') {
    return startersWithLanguages(
      sanitizedApp.starterPrompts,
      source.starterPrompts,
      lang,
      language,
      keepDraft
    );
  }
  return sanitizedApp[key] ?? null;
}

/** The first segment of a warning's `field`: `variables[0].label` → `variables`. */
function fieldRoot(field) {
  return String(field ?? '').split(/[.[]/)[0];
}

/**
 * Step 9: the issues of the patched app against the schema of its target.
 * Only issues on the patched keys count: the request's untouched content is
 * the author's own and is checked by the save.
 *
 * @returns {Array<{ path: Array<string|number>, code: string }>}
 */
function patchSchemaIssues({ source, draft, patch, personal, lang }) {
  const keys = new Set(Object.keys(patch));
  let result;
  if (personal) {
    result = userAppContentSchema.safeParse(applyRevisionPatch(source, patch));
  } else {
    const base = {
      ...newAppDefaults(lang),
      ...source,
      id: CHECK_APP_ID,
      allowEmptyContent: draft.allowEmptyContent === true
    };
    result = appConfigSchema.safeParse(applyRevisionPatch(base, patch));
  }
  if (result.success) return [];
  return result.error.issues.filter(issue => keys.has(String(issue.path[0])));
}

/**
 * Step 9: the patched app passes the schema of its target
 * ({@link patchSchemaIssues}).
 *
 * @throws {ServiceError} `APP_GENERATOR_INVALID_ANSWER` (`incomplete`)
 */
function assertPatchFitsSchema({ source, draft, patch, personal, lang, modelId }) {
  const issues = patchSchemaIssues({ source, draft, patch, personal, lang });
  if (issues.length === 0) return;
  // A bug in the sanitiser, not in the answer. The paths are logged, never a text.
  logger.error('A revised app does not pass the schema of its target', {
    component: COMPONENT,
    modelId,
    target: personal ? 'personal' : 'admin',
    issues: issues.map(issue => `${issue.path.join('.')}: ${issue.code}`)
  });
  throw invalidAnswer('incomplete', 'The change of the model could not be applied to the app');
}

/** A warning's `field` for a key the model may not change: the key, or `?` for a strange one. */
function ignoredField(key) {
  return /^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : '?';
}

/**
 * Step 7: what the model proposed for the keys it may change, and a
 * `KEY_IGNORED` warning per other key. Suggestions are read separately.
 */
function proposalOf(proposed, allowed, language) {
  const proposal = {};
  const warnings = [];
  for (const [key, value] of Object.entries(proposed)) {
    if (SUGGESTION_KEYS.includes(key)) continue;
    if (!allowed.includes(key)) {
      warnings.push({ code: 'KEY_IGNORED', field: ignoredField(key) });
      continue;
    }
    // A required text cannot be removed in a conversation: an empty proposal is no proposal.
    if (REQUIRED_TEXT_KEYS.has(key) && !textIn(value, language)) continue;
    proposal[key] = value;
  }
  return { proposal, warnings };
}

/** Step 8: the keys whose sanitised value differs before and after the proposal. */
function changedKeys(proposal, before, after) {
  const changed = Object.keys(proposal).filter(key => !sameValue(after.app[key], before.app[key]));
  // A field no text used got its line in the message template: the template changes with its
  // fields, also when `fields` does not name it, or the new field would be asked for and ignored.
  if (
    changed.includes('variables') &&
    !changed.includes('prompt') &&
    !sameValue(after.app.prompt, before.app.prompt)
  ) {
    changed.push('prompt');
  }
  return changed;
}

/**
 * `allowEmptyContent` is derived, never read: with a field in the message
 * template a user can send the form without typing a message. It is only
 * switched on, for an admin app; an admin's choice stays.
 */
function switchesOnEmptyContent({ changed, after, draft, personal }) {
  return (
    !personal &&
    (changed.includes('variables') || changed.includes('prompt')) &&
    after.app.allowEmptyContent === true &&
    draft.allowEmptyContent !== true
  );
}

/**
 * Steps 7 to 10: the patch, the changed keys, the warnings and the suggestions
 * of a change. `keepDraft` (default `true`) keeps the draft's own entries and
 * keys in `variables` and `starterPrompts` (see {@link patchValue}).
 */
function changeOf({
  answer,
  source,
  current,
  allowed,
  draft,
  language,
  lang,
  sanitizeOptions,
  keepDraft = true
}) {
  const proposed = isPlainObject(answer.change) ? answer.change : {};
  const { proposal, warnings } = proposalOf(proposed, allowed, language);
  const suggestionInput = sanitizeOptions.mayPropose
    ? Object.fromEntries(
        SUGGESTION_KEYS.filter(key => key in proposed).map(key => [key, proposed[key]])
      )
    : {};

  // Both runs go through the same sanitiser, so a key differs only where the model changed it.
  const before = sanitizeGeneratedApp(sanitiserInput(current, {}), sanitizeOptions);
  const after = sanitizeGeneratedApp(
    { ...sanitiserInput(current, proposal), ...suggestionInput },
    sanitizeOptions
  );

  const changed = changedKeys(proposal, before, after);
  const patch = {};
  for (const key of changed) {
    patch[key] = patchValue(key, after.app, source, lang, language, {
      unchangedApp: before.app,
      keepDraft
    });
  }
  if (switchesOnEmptyContent({ changed, after, draft, personal: sanitizeOptions.personal })) {
    patch.allowEmptyContent = true;
  }

  for (const warning of after.warnings) {
    if (warning.code !== 'KEY_IGNORED' && changed.includes(fieldRoot(warning.field))) {
      warnings.push(warning);
    }
  }
  return {
    patch,
    changed,
    warnings,
    suggestions: sanitizeOptions.mayPropose
      ? after.suggestions
      : { websearch: false, integrations: [] }
  };
}

/**
 * Steps 1 and 2: the keys the turn may change and the content it reads.
 *
 * @returns {{ keys: string[], allowed: string[], mayPropose: boolean, input: object,
 *   source: object, current: object }}
 */
function readContent({ draft, fields, language, target }) {
  // 1. Keys: the target's content keys, narrowed by `fields`.
  const keys = appRevisionKeys(target);
  const narrowed = Array.isArray(fields) && fields.length > 0;
  const allowed = narrowed ? keys.filter(key => fields.includes(key)) : [...keys];

  // 2. Current content: the target's keys, hidden characters removed.
  const input = isPlainObject(draft) ? draft : {};
  const source = {};
  for (const key of keys) if (input[key] !== undefined) source[key] = visibleDeep(input[key]);
  assertRevisable(source, language, target);
  return {
    keys,
    allowed,
    mayPropose: !narrowed,
    input,
    source,
    current: contentForModel(source, keys, language)
  };
}

/**
 * Steps 4 and 5: the messages of the turn and the one model call.
 *
 * @returns {Promise<{ result: object, mayAsk: boolean, categories: string[],
 *   installed: object[] }>}
 */
async function callModel({
  content,
  model,
  conversation,
  allowQuestions,
  language,
  user,
  personal,
  signal,
  llmClient
}) {
  const { allowed, mayPropose, current } = content;
  // 4. Messages.
  const turns = Array.isArray(conversation) ? conversation : [];
  const mayAsk = allowQuestions !== false && questionsSinceLastChange(turns) < REVISE_QUESTION_CAP;
  const categories = personal ? [] : appCategoryIds();
  const installed = mayPropose
    ? await installationsFor(user, language, personal ? { settings: personal.settings } : null)
    : [];
  const { messages } = buildRevisionMessages({
    content: current,
    earlier: turns.slice(0, -1),
    latest: turns.at(-1)?.text ?? '',
    language,
    keys: allowed,
    categories,
    mayAsk,
    mayPropose,
    integrationsBlock: integrationsBlock(installed)
  });

  // A request that was closed before this point must not start a paid call.
  if (signal?.aborted) {
    throw new ServiceError('ABORTED', 'The request was closed before the model was called');
  }

  // 5. Call. The same limits as a draft: one bounded call that a reasoning model cannot cut off.
  const result = await llmClient.complete({
    model,
    messages,
    options: { maxTokens: GENERATOR_MAX_TOKENS, responseFormat: 'json', thinkingEnabled: false },
    retries: 0,
    timeoutMs: GENERATOR_TIMEOUT_MS,
    signal,
    telemetry: { kind: 'utility', purpose: 'app-revise', user }
  });
  return { result, mayAsk, categories, installed };
}

/** An `OTHER_LANGUAGES_UNCHANGED` warning per changed text key of an app with other languages. */
function otherLanguageWarnings(source, language, changed) {
  if (!hasOtherLanguages(source, language)) return [];
  return changed
    .filter(
      key => REVISE_LOCALIZED_KEYS.includes(key) || key === 'variables' || key === 'starterPrompts'
    )
    .map(key => ({ code: REVISE_WARNINGS.OTHER_LANGUAGES_UNCHANGED, field: key }));
}

/** The parts of a turn that changes nothing: no question, no patch, no suggestions. */
function unchangedParts() {
  return {
    question: null,
    patch: {},
    changed: [],
    warnings: [],
    suggestions: { websearch: false, integrations: [] }
  };
}

/** Step 6 for a question: asked when the turn may ask, else what the model wrote is a message. */
function questionReply(answer, text, mayAsk) {
  const asked = questionOf(answer);
  if (mayAsk && asked.text)
    return { ...unchangedParts(), reply: 'question', text, question: asked };
  return { ...unchangedParts(), reply: 'message', text: text || asked.text };
}

/** Steps 7 to 10 for a change: the patch, checked against the schema, or a message. */
function changeReply({ answer, text, content, call, user, personal, language, lang, modelId }) {
  const { source, current, allowed, input, mayPropose } = content;
  const sanitizeOptions = {
    language,
    categories: call.categories,
    installed: call.installed,
    description: '',
    mayPropose,
    // The caps of the target: an admin app is not cut to the size of a personal app.
    limits: REVISE_CONTENT_LIMITS[personal ? 'personal' : 'admin'],
    personal: personal
      ? { webSearch: personal.settings?.capabilities?.webSearch === true && searchFor(user) }
      : null
  };
  const changeInput = {
    answer,
    source,
    current,
    allowed,
    draft: input,
    language,
    lang,
    sanitizeOptions
  };
  let outcome = changeOf(changeInput);
  if (outcome.changed.length === 0) {
    const warnings = [
      ...outcome.warnings.filter(warning => warning.code === 'KEY_IGNORED'),
      { code: REVISE_WARNINGS.NO_CHANGE, field: '' }
    ];
    return { ...unchangedParts(), reply: 'message', text, warnings };
  }
  // 9. The patched app passes the schema of its target. The draft's own entries and keys kept
  // in `variables` and `starterPrompts` are the author's, possibly half-edited in the form: when
  // they break the schema, the entries are built from the sanitiser alone, as a draft's are.
  const schemaCheck = { source, draft: input, personal, lang };
  if (patchSchemaIssues({ ...schemaCheck, patch: outcome.patch }).length > 0) {
    outcome = changeOf({ ...changeInput, keepDraft: false });
  }
  assertPatchFitsSchema({ ...schemaCheck, patch: outcome.patch, modelId });
  return {
    reply: 'change',
    text,
    question: null,
    patch: outcome.patch,
    changed: outcome.changed,
    suggestions: outcome.suggestions,
    warnings: [...outcome.warnings, ...otherLanguageWarnings(source, language, outcome.changed)]
  };
}

/** Step 6: the kind of reply, and for a change steps 7 to 10. */
function interpretAnswer({ answer, call, ...context }) {
  const reply = replyKind(answer);
  const text = plainText(answer.text);
  if (reply === 'question') return questionReply(answer, text, call.mayAsk);
  if (reply === 'change') return changeReply({ answer, text, call, ...context });
  return { ...unchangedParts(), reply: 'message', text };
}

/**
 * Have a chat model answer one turn of the conversation that changes an app.
 * Nothing is stored.
 *
 * The caller decides nothing about the model call: model, messages, token
 * limit and answer format are fixed here, as for a draft
 * ({@link import('./appGenerator.js').generateAppDraft}). The call counts
 * against the caller's usage limit (`telemetry.purpose: 'app-revise'`).
 *
 * @param {object} params
 * @param {object} params.draft - The app as the editor holds it. Only the content
 *   keys of the target are read ({@link appRevisionKeys}); `allowEmptyContent`
 *   is read for an admin app only, to tell whether a patch switches it on.
 * @param {Array<{ role: 'author'|'builder', kind?: string, text: string }>} params.conversation -
 *   1 to 12 entries, the last one by the author (checked by the route).
 * @param {string} params.language - The language of the app's texts in this turn.
 * @param {string[]} [params.fields] - A subset of the content keys the patch may hold.
 * @param {boolean} [params.allowQuestions=true] - `false`: the turn is never a question.
 * @param {object} params.user - The caller; limits the model and the suggestions.
 * @param {{ settings: object }|null} [params.personal] - Set for a personal app, with the
 *   effective `platform.userApps` settings: the content keys of a personal app, the
 *   personal-app schema and the personal ceiling for suggestions.
 * @param {AbortSignal} [params.signal] - Aborts the model call.
 * @param {object} [params.record] - Receives `modelId`, `usage`, `reply` and `changed`
 *   as far as the turn got, for the audit entry.
 * @param {{ complete: Function }} [params.llmClient] - The model client.
 * @returns {Promise<{ reply: 'question'|'change'|'message', text: string,
 *   question: { text: string, choices: string[], allowOther: true }|null, patch: object,
 *   changed: string[], suggestions: { websearch: boolean, integrations: object[] },
 *   warnings: Array<{ code: string, field: string }>, model: { id: string, name: string } }>}
 * @throws {ServiceError} `APP_REVISE_TOO_LONG` (400), `ABORTED` (499),
 *   `APP_GENERATOR_NO_MODEL` (503), `APP_GENERATOR_INVALID_ANSWER` (502). A failed
 *   model call throws the client's `LLMError`.
 * @example
 * const turn = await reviseApp({
 *   draft: { name: { en: 'Helper' }, description: { en: 'Helps.' }, system: { en: 'You help.' } },
 *   conversation: [{ role: 'author', text: 'Make it more formal' }],
 *   language: 'en',
 *   user: req.user
 * });
 * // → { reply: 'change', patch: { system: { en: 'You help. Address the reader formally.' } }, … }
 */
export async function reviseApp({
  draft,
  conversation,
  language,
  fields,
  allowQuestions = true,
  user,
  personal = null,
  signal,
  record = {},
  llmClient = defaultLlmClient
}) {
  const target = personal ? 'personal' : 'admin';
  const lang = baseLanguage(language);

  // 1. and 2. Keys and current content.
  const content = readContent({ draft, fields, language, target });

  // 3. Model.
  const model = pickDraftModel(user);
  record.modelId = model.id;

  // 4. and 5. Messages and call.
  const call = await callModel({
    content,
    model,
    conversation,
    allowQuestions,
    language,
    user,
    personal,
    signal,
    llmClient
  });
  const { result } = call;
  // The model was called and paid for, whatever becomes of its answer.
  record.usage = result?.usage || null;

  // 6. to 10. Parse, interpret, patch, schema check.
  const answer = parseGeneratedAnswer(result?.content, result?.finishReason);
  const turn = interpretAnswer({
    answer,
    call,
    content,
    user,
    personal,
    language,
    lang,
    modelId: model.id
  });

  const noChange = turn.warnings.some(warning => warning.code === REVISE_WARNINGS.NO_CHANGE);
  if (turn.reply === 'message' && !turn.text && !noChange) {
    throw invalidAnswer('incomplete', 'The answer of the model holds no reply');
  }

  record.reply = turn.reply;
  record.changed = turn.changed;

  logger.debug('Answered a revision turn', {
    component: COMPONENT,
    modelId: model.id,
    target,
    reply: turn.reply,
    changed: turn.changed,
    warnings: turn.warnings.length,
    finishReason: result?.finishReason ?? null
  });

  const defaultLanguage = configCache.getPlatform()?.defaultLanguage || 'en';
  return {
    reply: turn.reply,
    text: turn.text,
    question: turn.question,
    patch: turn.patch,
    changed: turn.changed,
    suggestions: turn.suggestions,
    warnings: turn.warnings,
    model: {
      id: model.id,
      name: getLocalizedString(model.name, lang, defaultLanguage, model.id)
    }
  };
}
