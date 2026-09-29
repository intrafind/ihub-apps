import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * Form-based start (issue #2581).
 *
 * An app with `startForm.enabled` opens a new chat with its variables — and a
 * drop zone when uploads are on — as a form instead of the composer. Submitting
 * renders the app's `prompt` with the answers once, here on the client, and
 * sends the result as the first user message. The chat then continues without
 * the template: follow-up messages go out as typed, as in an app without a
 * `prompt`, so the template is never rendered into the conversation again.
 */

// Same placeholder syntax the server fills (PromptService.replaceTemplateVar).
const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/**
 * @param {Object|null} app
 * @returns {boolean} Whether the app starts its chats with a form.
 */
export function isStartFormEnabled(app) {
  return app?.startForm?.enabled === true;
}

/**
 * The value each of the app's variables is sent with: what was entered, or the
 * variable's default when that is empty or whitespace — the same fallback the
 * composer applies on send.
 *
 * @param {Object|null} app
 * @param {Object} values - Variable name → entered value
 * @param {string} language
 * @returns {Object} Variable name → value
 */
export function resolveVariableValues(app, values, language) {
  const resolved = {};
  for (const variable of Array.isArray(app?.variables) ? app.variables : []) {
    const value = values?.[variable.name];
    const isEmpty =
      value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    resolved[variable.name] = isEmpty
      ? getLocalizedContent(variable.defaultValue, language) || ''
      : value;
  }
  return resolved;
}

/**
 * The required variables that have no value yet.
 *
 * @param {Object|null} app
 * @param {Object} values - Variable name → entered value
 * @returns {Array<Object>} The variable definitions
 */
export function getMissingRequiredVariables(app, values) {
  return (Array.isArray(app?.variables) ? app.variables : []).filter(variable => {
    if (!variable.required) return false;
    const value = values?.[variable.name];
    return value === undefined || value === null || String(value).trim() === '';
  });
}

/**
 * The first message of a form-started chat.
 *
 * The app's `prompt` in `language`, with every `{{variable}}` filled from
 * `values` and `{{content}}` removed: the form has no message field, and the
 * server wraps uploaded files around the text as it does for any message.
 * Other placeholders, such as `{{user_name}}` or `{{date}}`, are left for the
 * server, which fills global prompt variables in a message sent without a
 * template. One pass, so a `{{…}}` typed into an answer is never expanded.
 *
 * An app without a `prompt` in this language gets the answers as
 * "Label: value" lines instead, so the model still sees what was filled in.
 *
 * @param {Object|null} app
 * @param {Object} values - Variable name → value, defaults already applied
 * @param {string} language
 * @returns {string}
 */
export function renderStartFormPrompt(app, values, language) {
  const variables = Array.isArray(app?.variables) ? app.variables : [];
  const answers = {};
  for (const variable of variables) {
    const value = values?.[variable.name];
    answers[variable.name] = value === undefined || value === null ? '' : String(value);
  }

  const template = getLocalizedContent(app?.prompt, language);
  if (typeof template === 'string' && template.trim()) {
    return template
      .replace(PLACEHOLDER, (placeholder, key) => {
        if (key === 'content') return '';
        return Object.hasOwn(answers, key) ? answers[key] : placeholder;
      })
      .trim();
  }

  return variables
    .filter(variable => answers[variable.name].trim())
    .map(variable => {
      const label = getLocalizedContent(variable.label, language) || variable.name;
      const answer = answers[variable.name];
      const option = variable.predefinedValues?.find(o => o.value === answer);
      const value = option ? getLocalizedContent(option.label, language) || answer : answer;
      return `${label}: ${value}`;
    })
    .join('\n');
}
