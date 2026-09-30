/**
 * Prompt variables — the `{{name}}` placeholders of the prompt library.
 *
 * One module for both sides: the client builds the fill-in form and its live
 * preview from it, the server validates what a user stores with it. There is
 * one placeholder syntax, `{{name}}`, the same the app system prompts and the
 * global prompt variables use.
 *
 * A placeholder is one of three kinds:
 *
 *  - **automatic** — a built-in global variable (`{{user_name}}`, `{{date}}`,
 *    …) or one an admin defined under Admin → Prompts → Variables. Filled in
 *    without asking, from the values the server resolves for the user.
 *  - **`{{content}}`** — where the user's own text goes. It is taken out on
 *    insert and the caret is put there, so the user types or pastes into the
 *    right spot.
 *  - **everything else** — asked for in the fill-in form.
 *
 * A name the prompt declares metadata for (its `variables` array) is always
 * asked for, whatever kind it would otherwise be: declaring a variable is how
 * an author says "ask for this".
 *
 * @module shared/promptVariables
 */

/** What a variable name may look like — the same rule the prompt schema enforces. */
export const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/** Placeholder syntax. Strict on purpose: `{{ name }}` is not a placeholder anywhere else either. */
const PLACEHOLDER_PATTERN = /\{\{([a-zA-Z_][a-zA-Z0-9_-]*)\}\}/g;

/** The placeholder that marks where the user's own text goes. */
export const CONTENT_VARIABLE = 'content';

/**
 * Built-in global variables that fill themselves in.
 *
 * The same names `PromptService.resolveGlobalPromptVariables` produces, minus
 * `tone`: that one is the chat's style setting, which is usually unset, so a
 * prompt that uses `{{tone}}` gets it asked for instead of left behind as
 * literal text.
 */
export const BUILTIN_AUTO_VARIABLES = Object.freeze([
  'year',
  'month',
  'date',
  'date_iso',
  'time',
  'day_of_week',
  'timezone',
  'locale',
  'user_name',
  'user_email',
  'model_name',
  'location',
  'platform_context'
]);

/** Input types a variable can have. */
export const VARIABLE_TYPES = Object.freeze(['string', 'textarea', 'number', 'boolean', 'select']);

/**
 * Every placeholder name in a text, once each, in order of first appearance.
 *
 * @param {string} text - Prompt text.
 * @returns {string[]}
 */
export function extractVariableNames(text) {
  if (typeof text !== 'string' || !text.includes('{{')) return [];
  const names = [];
  const seen = new Set();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * A readable label for a variable that has none: `due_date` → `Due date`.
 *
 * @param {string} name - Variable name.
 * @returns {string}
 */
export function humanizeVariableName(name) {
  const words = String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/**
 * Whether a name fills itself in.
 *
 * @param {string} name - Variable name.
 * @param {Iterable<string>} [autoNames] - Names that fill themselves in: the
 *   built-ins plus the admin's custom global variables.
 * @returns {boolean}
 */
export function isAutoVariable(name, autoNames = BUILTIN_AUTO_VARIABLES) {
  for (const auto of autoNames) if (auto === name) return true;
  return false;
}

/**
 * The names that fill themselves in on this installation: the built-ins plus
 * the admin-defined custom global variables.
 *
 * @param {Object} [customVariables] - `platform.globalPromptVariables.variables`.
 * @returns {string[]}
 */
export function autoVariableNames(customVariables = {}) {
  const custom =
    customVariables && typeof customVariables === 'object' ? Object.keys(customVariables) : [];
  return [...new Set([...BUILTIN_AUTO_VARIABLES, ...custom])];
}

/**
 * The fields the fill-in form asks for.
 *
 * Detected placeholders come first, in the order the text uses them, each
 * merged with the metadata declared for it. Declared variables the text does
 * not use are only included with `includeUnused` — the library passes those to
 * the prompt's app as its `var_*` parameters, which is what they meant before
 * prompts had placeholders of their own.
 *
 * @param {string} text - Prompt text.
 * @param {Array<Object>} [declared] - The prompt's `variables` metadata.
 * @param {Object} [options]
 * @param {Iterable<string>} [options.autoNames] - Names that fill themselves in.
 * @param {boolean} [options.includeUnused=false] - Also return declared
 *   variables the text does not use.
 * @returns {Array<{name: string, label: *, description: *, type: string,
 *   required: boolean, defaultValue: *, predefinedValues: Array|undefined,
 *   declared: boolean, inText: boolean}>}
 */
export function buildVariableFields(
  text,
  declared = [],
  { autoNames = BUILTIN_AUTO_VARIABLES, includeUnused = false } = {}
) {
  const metadata = new Map();
  for (const variable of Array.isArray(declared) ? declared : []) {
    if (
      variable &&
      typeof variable.name === 'string' &&
      VARIABLE_NAME_PATTERN.test(variable.name)
    ) {
      if (!metadata.has(variable.name)) metadata.set(variable.name, variable);
    }
  }
  const autoList = [...autoNames];
  const fields = [];
  const used = new Set();

  const toField = (name, meta, inText) => {
    const type = VARIABLE_TYPES.includes(meta?.type) ? meta.type : 'string';
    return {
      name,
      label: meta?.label || humanizeVariableName(name),
      description: meta?.description || '',
      type,
      // A placeholder nobody described is a required free-text field: the
      // prompt reads wrong without it. A described one says for itself.
      required: meta ? meta.required === true : true,
      defaultValue: meta?.defaultValue,
      predefinedValues: Array.isArray(meta?.predefinedValues) ? meta.predefinedValues : undefined,
      declared: Boolean(meta),
      inText
    };
  };

  for (const name of extractVariableNames(text)) {
    used.add(name);
    const meta = metadata.get(name);
    if (!meta && (name === CONTENT_VARIABLE || isAutoVariable(name, autoList))) continue;
    fields.push(toField(name, meta, true));
  }
  if (includeUnused) {
    for (const [name, meta] of metadata) {
      if (!used.has(name)) fields.push(toField(name, meta, false));
    }
  }
  return fields;
}

/**
 * The form's starting values: each field's default, or empty.
 *
 * @param {ReturnType<typeof buildVariableFields>} fields
 * @param {Object} [remembered] - Values the user entered last time, which win
 *   over the defaults.
 * @returns {Object<string, *>}
 */
export function initialVariableValues(fields, remembered = {}) {
  const values = {};
  for (const field of fields || []) {
    if (remembered && Object.hasOwn(remembered, field.name)) {
      values[field.name] = remembered[field.name];
    } else if (field.defaultValue !== undefined && field.defaultValue !== null) {
      values[field.name] = field.defaultValue;
    } else {
      values[field.name] = field.type === 'boolean' ? false : '';
    }
  }
  return values;
}

/**
 * Required fields that have no value yet. A boolean always has one.
 *
 * @param {ReturnType<typeof buildVariableFields>} fields
 * @param {Object} values - Current form values.
 * @returns {string[]} Names of the missing fields.
 */
export function missingRequiredVariables(fields, values = {}) {
  const missing = [];
  for (const field of fields || []) {
    if (!field.required || field.type === 'boolean') continue;
    const value = values?.[field.name];
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.push(field.name);
    }
  }
  return missing;
}

/**
 * The prompt text with its placeholders filled in.
 *
 * Each placeholder takes, in this order: the user's value for it, the
 * automatic value for it, or — for `{{content}}` — nothing, with the caret
 * recorded where the first one was. A placeholder with none of these stays as
 * written, the same rule the server applies to a message it sends, so a
 * variable it can still resolve (`{{model_name}}` once a model is picked) is
 * resolved there.
 *
 * Values are inserted as typed: a value that itself contains `{{x}}` is not
 * filled in again here, by another field or an automatic value. The result
 * is an ordinary chat message, though, so the send pipeline still fills in
 * the automatic variables in all of it, as in anything typed into the chat.
 *
 * @param {string} text - Prompt text.
 * @param {Object} [values] - The user's values, by field name.
 * @param {Object} [options]
 * @param {Object} [options.autoValues] - Resolved automatic values, by name.
 * @returns {{text: string, caret: number|null}} The filled text, and where the
 *   caret belongs (null when the text has no `{{content}}`).
 */
export function fillPromptVariables(text, values = {}, { autoValues = {} } = {}) {
  if (typeof text !== 'string') return { text: '', caret: null };
  let out = '';
  let caret = null;
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const [placeholder, name] = match;
    out += text.slice(last, match.index);
    last = match.index + placeholder.length;
    if (values && Object.hasOwn(values, name)) {
      const value = values[name];
      out += value === undefined || value === null ? '' : String(value);
    } else if (
      autoValues &&
      Object.hasOwn(autoValues, name) &&
      autoValues[name] !== undefined &&
      autoValues[name] !== null &&
      autoValues[name] !== ''
    ) {
      out += String(autoValues[name]);
    } else if (name === CONTENT_VARIABLE) {
      if (caret === null) caret = out.length;
    } else {
      out += placeholder;
    }
  }
  out += text.slice(last);
  return { text: out, caret };
}
