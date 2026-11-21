// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Input fields of an app and the placeholders that carry their values.
 *
 * An input field (`app.variables[]`) reaches the model only where its
 * placeholder `{{name}}` stands in the instructions (`app.system`) or in the
 * message template (`app.prompt`): the prompt service replaces placeholders
 * where they occur and appends nothing for a field without one. A field that
 * no text uses is asked for and then ignored.
 *
 * Pure; imported by the server's draft sanitiser, the create page and the
 * input-field section of the editor. No function modifies its argument.
 *
 * @module shared/appPlaceholders
 */

import { CONTENT_VARIABLE } from './promptVariables.js';
import { VARIABLE_NAME_PATTERN } from './validationPatterns.js';

/** `{{name}}`, with the name rule of the app schema. `{{ name }}` is not a placeholder. */
const PLACEHOLDER_SOURCE = String.raw`\{\{(${VARIABLE_NAME_PATTERN.source.replace(/^\^|\$$/g, '')})\}\}`;

/** The language of a new template when neither the caller nor the label names one. */
const FALLBACK_LANGUAGE = 'en';

/** The name a field gets when its label has no usable character. */
const FALLBACK_NAME = 'field';

/** The longest name {@link placeholderFromLabel} derives, before a suffix. */
const MAX_NAME_LENGTH = 40;

const TRANSLITERATIONS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** The texts of a localized value (or of a plain string). */
function textsOf(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter(text => typeof text === 'string');
}

/** The placeholder names found in any of the given localized values. */
function namesIn(...values) {
  return new Set(values.flatMap(textsOf).flatMap(placeholdersIn));
}

function variablesOf(app) {
  return Array.isArray(app?.variables) ? app.variables.filter(Boolean) : [];
}

/** Whether a text contains the placeholder of a field. */
function usesName(text, name) {
  return placeholdersIn(text).includes(name);
}

/**
 * The names of the placeholders in a text, each once, in the order of their
 * first occurrence. `{{content}}` marks where the user's message goes; it is
 * not an input field and is left out.
 *
 * @param {string} text
 * @returns {string[]}
 *
 * @example
 * placeholdersIn('Tone: {{tone}}\n{{content}} ({{tone}}, {{length}})'); // → ['tone', 'length']
 */
export function placeholdersIn(text) {
  if (typeof text !== 'string') return [];
  const names = [];
  for (const match of text.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))) {
    const name = match[1];
    if (name !== CONTENT_VARIABLE && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The input fields whose placeholder stands in no language of the
 * instructions or of the message template. The AI does not receive what
 * users enter there. A field without a name has no placeholder and is not
 * listed.
 *
 * @param {object} app
 * @returns {object[]} Entries of `app.variables`.
 *
 * @example
 * unusedVariables({ system: { en: 'Write in a {{tone}} tone.' }, variables: [{ name: 'tone' }, { name: 'length' }] });
 * // → [{ name: 'length' }]
 */
export function unusedVariables(app) {
  const used = namesIn(app?.system, app?.prompt);
  return variablesOf(app).filter(variable => variable.name && !used.has(variable.name));
}

/**
 * The names of the input fields whose placeholder stands in any language of
 * the instructions. Removing such a field would leave its placeholder in a
 * sentence.
 *
 * @param {object} app
 * @returns {string[]}
 */
export function variablesUsedInInstructions(app) {
  const used = namesIn(app?.system);
  return variablesOf(app)
    .map(variable => variable.name)
    .filter(name => name && used.has(name));
}

/** The label of a field in a language, else in any language, else its name. */
function labelOf(variable, language) {
  const label = variable?.label;
  const text =
    (typeof label === 'string' ? label : label?.[language]) ||
    textsOf(label).find(candidate => candidate.trim()) ||
    variable?.name ||
    '';
  return String(text)
    .trim()
    .replace(/[\s:]+$/, '');
}

/**
 * Append the line `<label>: {{name}}` to the message template, so the model
 * receives what users enter in the field. With a language, the template of
 * that language is extended (and created when the app has none). Without a
 * language, every language the template has is extended, each with the label
 * in that language; an app without a template gets one in the label's first
 * language. A template that already uses the field stays as it is, and so
 * does the app when the field has no name.
 *
 * A template needs no `{{content}}`: the prompt service appends the user's
 * message to a template without it.
 *
 * @param {object} app
 * @param {{ name: string, label?: Object<string, string>|string }} variable
 * @param {string} [language] - The language of the template to extend.
 * @returns {object} A new app; `app` is not modified.
 *
 * @example
 * addVariableToTemplate({ prompt: { en: '{{content}}' } }, { name: 'tone', label: { en: 'Tone' } }, 'en').prompt;
 * // → { en: '{{content}}\nTone: {{tone}}' }
 */
export function addVariableToTemplate(app, variable, language) {
  const name = variable?.name;
  if (!name) return app;

  const labelLanguages =
    variable.label && typeof variable.label === 'object' ? Object.keys(variable.label) : [];
  const template =
    typeof app?.prompt === 'string'
      ? { [language || labelLanguages[0] || FALLBACK_LANGUAGE]: app.prompt }
      : app?.prompt && typeof app.prompt === 'object'
        ? app.prompt
        : {};

  const templateLanguages = Object.keys(template);
  const targets = language
    ? [language]
    : templateLanguages.length > 0
      ? templateLanguages
      : [labelLanguages[0] || FALLBACK_LANGUAGE];

  const next = { ...template };
  let changed = false;
  for (const target of targets) {
    const current = typeof next[target] === 'string' ? next[target] : '';
    if (usesName(current, name)) continue;
    const line = `${labelOf(variable, target)}: {{${name}}}`;
    const body = current.trimEnd();
    next[target] = body ? `${body}\n${line}` : line;
    changed = true;
  }
  return changed ? { ...app, prompt: next } : app;
}

/**
 * A text without the lines that use one of the given placeholders. Other
 * lines stay as they are. Only a text that lost a line is tidied: no blank
 * lines at its ends, and no gap where the line stood.
 *
 * @param {string} text
 * @param {Iterable<string>} names - Placeholder names, without the braces.
 * @returns {string} Empty when no line is left.
 *
 * @example
 * removePlaceholderLines('Tone: {{tone}}\n{{content}}', ['tone']); // → '{{content}}'
 */
export function removePlaceholderLines(text, names) {
  if (typeof text !== 'string') return '';
  const dropped = [...(names || [])].filter(Boolean);
  if (dropped.length === 0) return text;
  const lines = text.split('\n');
  const kept = lines.filter(line => !dropped.some(name => usesName(line, name)));
  if (kept.length === lines.length) return text;
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove every input field, and from every language of the message template
 * the lines that use one of them. Other lines stay as they are. A language
 * that is left without text is dropped, and so is a template without a
 * language. The instructions are not touched: check
 * {@link variablesUsedInInstructions} first.
 *
 * @param {object} app
 * @returns {object} A new app with `variables: []`; `app` is not modified.
 *
 * @example
 * removeVariables({ prompt: { en: 'Tone: {{tone}}\n{{content}}' }, variables: [{ name: 'tone' }] });
 * // → { prompt: { en: '{{content}}' }, variables: [] }
 */
export function removeVariables(app) {
  const names = variablesOf(app)
    .map(variable => variable.name)
    .filter(Boolean);
  const result = { ...app, variables: [] };
  if (names.length === 0 || !app?.prompt || typeof app.prompt !== 'object') return result;

  const template = {};
  for (const [language, text] of Object.entries(app.prompt)) {
    if (typeof text !== 'string') continue;
    const next = removePlaceholderLines(text, names);
    if (next) template[language] = next;
  }

  if (Object.keys(template).length > 0) {
    result.prompt = template;
  } else {
    delete result.prompt;
  }
  return result;
}

/**
 * The placeholder name for a field, derived from its label: lower case, ä, ö,
 * ü and ß spelled out, other marks stripped, every other run of characters
 * turned into `_`. The result always matches `VARIABLE_NAME_PATTERN`. A name
 * that is taken, or `content` (the placeholder of the user's message), gets a
 * numeric suffix.
 *
 * @param {string} label
 * @param {Iterable<string>} [taken] - Names already in use in the app.
 * @returns {string}
 *
 * @example
 * placeholderFromLabel('Reading level'); // → 'reading_level'
 * placeholderFromLabel('Länge', ['laenge']); // → 'laenge_2'
 * placeholderFromLabel('1. Entwurf'); // → 'field_1_entwurf'
 */
export function placeholderFromLabel(label, taken) {
  const used = new Set(taken ? [...taken].filter(name => typeof name === 'string') : []);
  used.add(CONTENT_VARIABLE);

  let base = String(label ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[äöüß]/g, char => TRANSLITERATIONS[char])
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = FALLBACK_NAME;
  if (!/^[a-z]/.test(base)) base = `${FALLBACK_NAME}_${base}`;
  base = base.slice(0, MAX_NAME_LENGTH).replace(/_+$/, '');

  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}
