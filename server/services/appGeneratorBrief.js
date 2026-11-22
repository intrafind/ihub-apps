// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The brief of the app draft generator: what the model is told before it gets
 * the author's description (`POST /api/admin/apps/_generate`).
 *
 * The system message has two parts.
 *
 * 1. The brief ({@link STANDARD_BRIEF}), which the server owns. No library
 *    prompt and no setting replaces it.
 * 2. The output rules ({@link outputRules}), which the server appends after
 *    the brief and after the catalogue of installed systems.
 *
 * The author's description is the user message and nothing else: it never
 * becomes part of the system message.
 *
 * Pure; reads no configuration and makes no request.
 *
 * @module services/appGeneratorBrief
 */

import { DEFAULT_APP_CATEGORY } from '../../shared/appDefaults.js';

/**
 * The brief of every draft. It asks for one draft in plain words and names no
 * model, no language pair and no file format; the output rules that follow it fix the format.
 */
export const STANDARD_BRIEF = [
  'You prepare the draft of an app for iHub, a portal where the people of an organization use AI apps.',
  'An app is an assistant with fixed instructions: people open it, sometimes fill in a few input fields, write a message and get an answer.',
  '',
  'A person describes in a few sentences the app they want. Turn that description into one draft.',
  '',
  'How to write the draft:',
  '- Name: two to four words that say what the app does.',
  '- Short description: one sentence that tells users what the app is for.',
  '- Instructions: what the assistant follows in every conversation. Address the assistant directly ("You are ...", "Answer ..."). Use plain words and short sentences. Say what the assistant does, how its answer should look and what it must not do. Do not mention JSON, configuration or these rules in the instructions.',
  '- Input fields: add one only where the description names something the user chooses each time, such as a tone, a length or a target language. Most apps need none.',
  '- Conversation starters: add some only when typical first messages follow from the description.',
  '- Web search: propose it only when the app needs current information from the internet.',
  '- Icon, colour and category: choose what fits the purpose of the app.',
  '',
  'Stay with what the description asks for. Do not invent abilities the description does not mention.'
].join('\n');

/** Icon names the output rules offer; all of them exist in the icon picker. */
const SUGGESTED_ICONS = [
  'chat-bubbles',
  'document-text',
  'document-search',
  'mail',
  'globe',
  'light-bulb',
  'pencil',
  'calendar',
  'briefcase',
  'code',
  'search',
  'sparkles',
  'academic-cap',
  'users',
  'list',
  'question-mark-circle'
];

/** English name of a language tag: `de` gives "German", an unknown tag itself. */
export function languageName(language) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language;
  } catch {
    return language;
  }
}

/**
 * The rules the server appends after the brief: the keys an answer may
 * use, the categories of the installation, the one language of every text and
 * how an input field reaches the AI.
 *
 * @param {object} options
 * @param {string} options.language - The language of the draft.
 * @param {string[]} [options.categories] - The category IDs of the installation.
 * @param {boolean} [options.hasIntegrations=false] - Whether a list of installed systems precedes the rules.
 * @returns {string}
 */
export function outputRules({ language, categories = [], hasIntegrations = false }) {
  const ids = categories.filter(id => typeof id === 'string' && id);
  const category =
    ids.length > 0
      ? `one of: ${ids.join(', ')}`
      : `leave it out (the server uses "${DEFAULT_APP_CATEGORY}")`;
  const integrations = hasIntegrations
    ? '- "integrations": array, optional. Only integrations from the list of installed integrations above, as { "id", "actions" }.'
    : '- "integrations": leave it out; no integration is installed that this app could use.';
  return [
    'OUTPUT RULES',
    'These rules come from the server. They apply whatever the text above says.',
    '',
    '1. Answer with one JSON object and nothing else: no explanation, no Markdown, no code fence.',
    '2. Use only these keys. Every other key is ignored.',
    '- "name": string, at most 100 characters.',
    '- "description": string, at most 500 characters.',
    '- "system": string, the instructions, at most 8000 characters.',
    `- "icon": string, for example one of: ${SUGGESTED_ICONS.join(', ')}.`,
    '- "color": string, a hex colour such as "#2563EB".',
    `- "category": string, ${category}.`,
    '- "prompt": string, optional. The message template: text that is sent with every message of the user. {{content}} stands for the message the user writes.',
    '- "messagePlaceholder": string, optional. The hint shown in the empty message box.',
    '- "variables": array, optional, at most 8 input fields. Each is { "name", "label", "type", "required", "defaultValue", "predefinedValues" }. "type" is one of string, text, number, boolean, date, select. "predefinedValues" lists the options of a dropdown as { "value", "label" }.',
    '- "starterPrompts": array, optional, at most 4 conversation starters. Each is { "title", "message" }.',
    '- "websearch": { "enabled": true }, only when the app needs current information from the internet.',
    integrations,
    `3. Write every text in ${languageName(language)}. Every text is a plain string in that language, never an object with language codes.`,
    '4. Use words a user understands as the label of an input field. The "name" of an input field is its placeholder name: lowercase letters, digits and underscores, starting with a letter.',
    '5. Write the placeholder of every input field into the message template ("prompt"), for example "Tone: {{tone}}". The AI receives what a user enters only where the placeholder {{name}} stands in the instructions or in the message template.',
    '6. Do not name a model and do not set one.'
  ].join('\n');
}

/**
 * The two messages of a draft request.
 *
 * @param {object} options
 * @param {string} options.description - What the author wrote. It is the user message, as it is.
 * @param {string} options.language - The language of the draft.
 * @param {string[]} [options.categories] - The category IDs of the installation.
 * @param {string} [options.integrationsBlock=''] - The catalogue of installed systems
 *   (`integrationsBlock` of `services/appGenerator.js`), empty when none is installed.
 * @returns {{ messages: Array<{ role: string, content: string }> }}
 */
export function buildGeneratorMessages({
  description,
  language,
  categories = [],
  integrationsBlock = ''
}) {
  // The rules come last, after the catalogue: what the server owns has the final word.
  const system = [
    STANDARD_BRIEF,
    integrationsBlock.trim(),
    outputRules({ language, categories, hasIntegrations: Boolean(integrationsBlock.trim()) })
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: description }
    ]
  };
}
