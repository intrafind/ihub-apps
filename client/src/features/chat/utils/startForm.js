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
 * The app's variables with their texts in `language`, the shape
 * `InputVariables` renders.
 *
 * @param {Array<Object>|undefined} variables - `app.variables`
 * @param {string} language
 * @returns {Array<Object>}
 */
export function localizeVariables(variables, language) {
  if (!Array.isArray(variables)) return [];
  return variables.map(variable => ({
    ...variable,
    localizedLabel: getLocalizedContent(variable.label, language) || variable.name,
    localizedDescription: getLocalizedContent(variable.description, language),
    localizedDefaultValue: getLocalizedContent(variable.defaultValue, language),
    localizedPlaceholder: getLocalizedContent(variable.placeholder, language),
    predefinedValues: variable.predefinedValues
      ? variable.predefinedValues.map(option => ({
          ...option,
          localizedLabel: getLocalizedContent(option.label, language) || option.value
        }))
      : undefined
  }));
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
 * `values` and `{{content}}` from `content` — text the chat was opened with
 * (`?prefill=`), usually none; a template without `{{content}}` gets it
 * appended, as the server does. Uploaded files are not part of it: the server
 * wraps them around the text as it does for any message. Other placeholders,
 * such as `{{user_name}}` or `{{date}}`, are left for the server, which fills
 * global prompt variables in a message sent without a template. One pass, so a
 * `{{…}}` typed into an answer is never expanded.
 *
 * An app without a `prompt` in this language gets the answers as
 * "Label: value" lines instead, so the model still sees what was filled in.
 *
 * @param {Object|null} app
 * @param {Object} values - Variable name → value, defaults already applied
 * @param {string} language
 * @param {string} [content=''] - The message text, for `{{content}}`
 * @returns {string}
 */
export function renderStartFormPrompt(app, values, language, content = '') {
  const variables = Array.isArray(app?.variables) ? app.variables : [];
  const answers = {};
  for (const variable of variables) {
    const value = values?.[variable.name];
    answers[variable.name] = value === undefined || value === null ? '' : String(value);
  }

  const message = typeof content === 'string' ? content.trim() : '';
  const withMessage = text => [text, message].filter(Boolean).join('\n\n');

  const template = getLocalizedContent(app?.prompt, language);
  if (typeof template === 'string' && template.trim()) {
    const rendered = template
      .replace(PLACEHOLDER, (placeholder, key) => {
        if (key === 'content') return message;
        return Object.hasOwn(answers, key) ? answers[key] : placeholder;
      })
      .trim();
    return template.includes('{{content}}') ? rendered : withMessage(rendered);
  }

  return withMessage(
    variables
      .filter(variable => answers[variable.name].trim())
      .map(variable => {
        const label = getLocalizedContent(variable.label, language) || variable.name;
        const answer = answers[variable.name];
        const option = variable.predefinedValues?.find(o => o.value === answer);
        const value = option ? getLocalizedContent(option.label, language) || answer : answer;
        return `${label}: ${value}`;
      })
      .join('\n')
  );
}
