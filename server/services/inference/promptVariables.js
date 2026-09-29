/**
 * App variables through the Responses API's `prompt` parameter.
 *
 * An iHub app is a server-side prompt template with variables, which is
 * exactly what `prompt: { id, version, variables }` describes, so the API
 * reuses it (and Chat Completions accepts the same object as an extension
 * field). The app is chosen by `model` alone: `prompt.id` is optional and,
 * when present, must name the same app; `prompt.version` is ignored because
 * apps are not versioned.
 *
 * Values are checked against the app's `variables` definitions — the ones
 * `GET /api/apps/:appId` publishes — and every problem is reported in one
 * 400. What comes out is what the chat UI would send: every declared
 * variable, as a string, missing ones filled from their localized default.
 *
 * @module services/inference/promptVariables
 */
import { getLocalizedContent } from '../../../shared/localize.js';
import { InferenceApiError } from './errors.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Content-part types OpenAI allows as a variable value that iHub has no variable type for. */
const FILE_VALUE_TYPES = new Set(['input_file', 'input_image']);

/**
 * The localized default of a variable, as a value: a default that names an
 * option's label (the chat UI allows that) resolves to the option's value.
 *
 * @param {Object} variable - Variable definition.
 * @param {string} language
 * @param {string} fallbackLanguage
 * @returns {string|undefined}
 */
function defaultOf(variable, language, fallbackLanguage) {
  if (variable.defaultValue === undefined || variable.defaultValue === null) return undefined;
  const text =
    typeof variable.defaultValue === 'object'
      ? getLocalizedContent(variable.defaultValue, language, fallbackLanguage)
      : String(variable.defaultValue);
  const options = Array.isArray(variable.predefinedValues) ? variable.predefinedValues : [];
  if (options.length === 0 || options.some(option => option.value === text)) return text;
  const byLabel = options.find(
    option => getLocalizedContent(option.label, language, fallbackLanguage) === text
  );
  return byLabel ? byLabel.value : text;
}

/** Whether a calendar date in ISO form exists. */
function isRealDate(value) {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Check and coerce one value against its definition.
 *
 * @param {Object} variable - Definition.
 * @param {unknown} raw - Value from the request.
 * @returns {{value?: string, error?: {code: string, message: string}}}
 */
function coerce(variable, raw) {
  let value = raw;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (FILE_VALUE_TYPES.has(value.type)) {
      return {
        error: {
          code: 'file_value_not_supported',
          message:
            'files are not variable values; send documents and images as input_file / input_image in input'
        }
      };
    }
    if (value.type === 'input_text' && typeof value.text === 'string') value = value.text;
  }

  const type = variable.type || 'string';
  if (type === 'number') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value))
        return { error: { code: 'invalid_type', message: 'must be a finite number' } };
      value = String(value);
    } else if (typeof value !== 'string' || !NUMERIC.test(value.trim())) {
      return { error: { code: 'invalid_type', message: 'must be a number' } };
    } else {
      value = value.trim();
    }
  } else if (type === 'boolean') {
    if (typeof value === 'boolean') value = String(value);
    else if (typeof value === 'string' && ['true', 'false'].includes(value.trim().toLowerCase())) {
      value = value.trim().toLowerCase();
    } else {
      return { error: { code: 'invalid_type', message: 'must be true or false' } };
    }
  } else if (type === 'date') {
    if (typeof value !== 'string' || !isRealDate(value.trim())) {
      return { error: { code: 'invalid_type', message: 'must be a date in the form YYYY-MM-DD' } };
    }
    value = value.trim();
  } else if (typeof value !== 'string') {
    return { error: { code: 'invalid_type', message: 'must be a string' } };
  }

  // A select variable, or any variable with predefined values, takes one of them.
  const options = Array.isArray(variable.predefinedValues) ? variable.predefinedValues : [];
  if (options.length > 0) {
    if (!options.some(option => option.value === value)) {
      return {
        error: {
          code: 'invalid_value',
          message: `must be one of: ${options.map(option => option.value).join(', ')}`
        }
      };
    }
  }
  return { value };
}

/**
 * Validate the `prompt` parameter of a request for an app.
 *
 * @param {Object} options
 * @param {unknown} options.prompt - The request's `prompt`.
 * @param {Object} options.app - The app the request runs.
 * @param {string} options.language - Request language (defaults are localized in it).
 * @param {string} [options.fallbackLanguage='en'] - Platform default language.
 * @param {boolean} [options.enforceRequired=true] - Refuse a missing required variable
 *   without a default. A conversation follow-up that sends no variables runs on the ones
 *   the conversation already has, so there it is off.
 * @returns {{provided: boolean, variables: Object<string, string>}} `provided` is true
 *   when the request carried `prompt.variables`; `variables` always holds every declared
 *   variable (defaults for the missing ones).
 * @throws {InferenceApiError} 400 with per-variable `details`.
 */
export function resolvePromptVariables({
  prompt,
  app,
  language,
  fallbackLanguage = 'en',
  enforceRequired = true
}) {
  const definitions = Array.isArray(app?.variables) ? app.variables : [];
  let given = null;

  if (prompt !== undefined && prompt !== null) {
    if (typeof prompt !== 'object' || Array.isArray(prompt)) {
      throw new InferenceApiError(400, 'invalid_prompt', 'prompt must be an object', {
        param: 'prompt'
      });
    }
    if (prompt.id !== undefined && prompt.id !== null) {
      if (
        typeof prompt.id !== 'string' ||
        prompt.id.toLowerCase() !== String(app.id).toLowerCase()
      ) {
        throw new InferenceApiError(
          400,
          'prompt_id_mismatch',
          `prompt.id '${String(prompt.id)}' does not match the app in model (${app.id})`,
          { param: 'prompt.id' }
        );
      }
    }
    if (prompt.variables !== undefined && prompt.variables !== null) {
      if (typeof prompt.variables !== 'object' || Array.isArray(prompt.variables)) {
        throw new InferenceApiError(400, 'invalid_prompt', 'prompt.variables must be an object', {
          param: 'prompt.variables'
        });
      }
      given = prompt.variables;
    }
  }

  const errors = [];
  const variables = {};
  const byName = new Map(definitions.map(variable => [variable.name, variable]));

  for (const name of Object.keys(given || {})) {
    if (!byName.has(name)) {
      errors.push({
        variable: name,
        code: 'unknown_variable',
        message: `app ${app.id} has no variable '${name}'`
      });
    }
  }

  for (const variable of definitions) {
    const has = given && Object.hasOwn(given, variable.name) && given[variable.name] !== null;
    if (has) {
      const { value, error } = coerce(variable, given[variable.name]);
      if (error) errors.push({ variable: variable.name, ...error });
      else variables[variable.name] = value;
      continue;
    }
    const fallback = defaultOf(variable, language, fallbackLanguage);
    if (fallback !== undefined && fallback !== '') {
      variables[variable.name] = fallback;
    } else if (variable.required === true && enforceRequired) {
      errors.push({
        variable: variable.name,
        code: 'missing_required',
        message: 'is required and has no default'
      });
    } else {
      // What the chat UI sends for an optional variable left empty.
      variables[variable.name] = fallback ?? '';
    }
  }

  if (errors.length > 0) {
    throw new InferenceApiError(
      400,
      'invalid_prompt_variables',
      `Invalid prompt variables for app ${app.id}: ${errors
        .map(error => `${error.variable} ${error.message}`)
        .join('; ')}`,
      { param: 'prompt.variables', details: errors }
    );
  }
  return { provided: given !== null, variables };
}

/**
 * Refuse `prompt` on a plain model: there is no server-side template to fill.
 *
 * @param {unknown} prompt
 * @throws {InferenceApiError}
 */
export function assertNoPromptForModel(prompt) {
  if (prompt !== undefined && prompt !== null) {
    throw new InferenceApiError(
      400,
      'prompt_requires_app',
      'prompt is only supported for apps (model: app:<appId>); a plain model has no server-side prompt template',
      { param: 'prompt' }
    );
  }
}
