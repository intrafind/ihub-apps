// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The brief of the app draft generator: what the model is told before it gets
 * the author's description (`POST /api/admin/apps/_generate`).
 *
 * The system message has two parts.
 *
 * 1. The brief. The server owns one ({@link STANDARD_BRIEF}). The library
 *    prompt `app-generator` replaces it only when an admin changed that prompt
 *    ({@link chooseBrief}); the shipped library text is never used, because it
 *    asks for two languages and names a model.
 * 2. The output rules ({@link outputRules}), which the server appends after
 *    either brief and after the catalogue of installed systems. A customised
 *    library prompt can therefore add to a draft but cannot remove the format
 *    rules.
 *
 * The author's description is the user message and nothing else: it never
 * becomes part of the system message.
 *
 * Pure; reads no configuration and makes no request.
 *
 * @module services/appGeneratorBrief
 */

import { createHash } from 'node:crypto';
import { DEFAULT_APP_CATEGORY } from '../../shared/appDefaults.js';

/** The id of the library prompt an admin can change to steer drafts. */
export const APP_GENERATOR_PROMPT_ID = 'app-generator';

/**
 * The hash ({@link hashBriefPrompt}) of the `prompt` object of every version
 * of `server/defaults/prompts/app-generator.json` the repository history
 * gives, and of each such version after migration V231, which rewrote the
 * stored copy (it removed the `actions` block of the example). A library
 * prompt whose hash is listed here was never changed by an admin.
 *
 * When the shipped file changes, add the hash of its new `prompt` object; a
 * test fails until it is listed, so that an edit of the file cannot turn every
 * installation into "customised" unnoticed.
 */
export const SHIPPED_BRIEF_HASHES = Object.freeze([
  '1fbdc539d9dec02b54769184ef5fafdd6ce22c48b2c70c01b7de2113cf5796ce', // 2025-04-14 e7ab9d3
  '2d72216e43f24c1e3f3c71069ec7009f3231a208c650e768908d57528a4732e1', // 2025-07-28 833f151
  'f157c15798abb911868e05ccc91a87076f2e91ad8f1738efa8ed0afa90ce9b3e', // 2025-07-28 833f151, after V231
  '74666b4670d567f4a2b191f7988823c182dec215cbdcc3e416711046a44b9c90', // 2025-08-07 45f9923
  '68ba097f665b186b97efb4e3251fec88051deafb200e87366c1930134a331347', // 2025-08-07 45f9923, after V231
  '1836f9f6f2fa025eb9547234d76196af6c39d12890295b8a4f80cc24fa4ca245', // 2026-06-16 9304a1e
  'd608c9e772fe0cc2bb44b1b76799ca36bce80a642b2f37bc8964277861fff442', // 2026-06-16 9304a1e, after V231
  '7ac3e605326691c135473533978b442b44db29c4d5007e5163c595b396e3d148', // 2026-10-19 76eb2de
  'ee7927c1c5ae8aa636ee1daedd2a240fb70e1550c62a539cc42d1cde176c12f9', // 2026-10-19 76eb2de, after V231
  'f2d138641a6c65b486d12daab8332cd599000bc3b85669e99270f0b46ff0aec5', // 2026-10-23 386db87
  '81d8cda8a68c3a8243c178b3ee5e005e3f48ae8e70bd904a0d484b3485573177', // 2026-10-23 386db87, after V231
  '5b5b88074810351ebb2ad82e3e20f26331e597af4707f087b37150cd15f95ab0' // 2026-11-07 950015c (current)
]);

/**
 * The brief the server uses unless an admin changed the library prompt. It
 * asks for one draft in plain words and names no model, no language pair and
 * no file format; the output rules that follow it fix the format.
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The texts of a localized prompt, per language, with line endings and outer blanks normalised. */
function normalisedTexts(prompt) {
  return Object.keys(prompt)
    .sort()
    .map(language => [language, String(prompt[language]).replace(/\r\n?/g, '\n').trim()]);
}

/**
 * The hash that tells a shipped library prompt from a changed one: SHA-256
 * over the texts of the prompt's `prompt` object, in the order of their
 * language codes. Line endings and blanks at the ends of a text do not count,
 * so a prompt that was only opened and saved in the editor stays "shipped".
 *
 * @param {Object<string, string>} prompt - `prompt` of a prompt file.
 * @returns {string} 64 hexadecimal characters; empty for anything that is not an object.
 */
export function hashBriefPrompt(prompt) {
  if (!isPlainObject(prompt)) return '';
  return createHash('sha256')
    .update(JSON.stringify(normalisedTexts(prompt)))
    .digest('hex');
}

/** English name of a language tag: `de` gives "German", an unknown tag itself. */
export function languageName(language) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language;
  } catch {
    return language;
  }
}

/** The text of a library prompt in a language, else the platform default, English or any language. */
function textOf(prompt, language, defaultLanguage) {
  const base = String(language || '').split('-')[0];
  const candidates = [
    prompt[language],
    prompt[base],
    prompt[defaultLanguage],
    prompt.en,
    ...Object.values(prompt)
  ];
  const text = candidates.find(candidate => typeof candidate === 'string' && candidate.trim());
  return text ? text.trim() : '';
}

/**
 * Which brief a draft is prepared with.
 *
 * The library prompt `app-generator` is used when it exists, is enabled, has
 * text, and that text differs from every released version of the shipped file
 * ({@link SHIPPED_BRIEF_HASHES}): an admin customised it. In every other case
 * (no prompt, a disabled one, the shipped text) the server's own brief is
 * used.
 *
 * @param {object|null|undefined} libraryPrompt - The prompt `app-generator`, or nothing.
 * @param {string} language - The language of the draft.
 * @param {string} [defaultLanguage='en'] - The platform's default language.
 * @returns {{ brief: 'standard'|'customised', text: string }}
 *
 * @example
 * chooseBrief(null, 'de'); // → { brief: 'standard', text: STANDARD_BRIEF }
 */
export function chooseBrief(libraryPrompt, language, defaultLanguage = 'en') {
  const standard = { brief: 'standard', text: STANDARD_BRIEF };
  if (!isPlainObject(libraryPrompt) || libraryPrompt.enabled === false) return standard;
  if (!isPlainObject(libraryPrompt.prompt)) return standard;
  if (SHIPPED_BRIEF_HASHES.includes(hashBriefPrompt(libraryPrompt.prompt))) return standard;
  const text = textOf(libraryPrompt.prompt, language, defaultLanguage);
  return text ? { brief: 'customised', text } : standard;
}

/**
 * The rules the server appends after either brief: the keys an answer may
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
 * @param {object|null} [options.libraryPrompt] - The library prompt `app-generator`, when there is one.
 * @param {string} options.description - What the author wrote. It is the user message, as it is.
 * @param {string} options.language - The language of the draft.
 * @param {string} [options.defaultLanguage='en'] - The platform's default language.
 * @param {string[]} [options.categories] - The category IDs of the installation.
 * @param {string} [options.integrationsBlock=''] - The catalogue of installed systems
 *   (`integrationsBlock` of `services/appGenerator.js`), empty when none is installed.
 * @returns {{ brief: 'standard'|'customised', messages: Array<{ role: string, content: string }> }}
 */
export function buildGeneratorMessages({
  libraryPrompt = null,
  description,
  language,
  defaultLanguage = 'en',
  categories = [],
  integrationsBlock = ''
}) {
  const { brief, text } = chooseBrief(libraryPrompt, language, defaultLanguage);
  // The rules come last, after the catalogue: what the server owns has the final word.
  const system = [
    text,
    integrationsBlock.trim(),
    outputRules({ language, categories, hasIntegrations: Boolean(integrationsBlock.trim()) })
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    brief,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: description }
    ]
  };
}
