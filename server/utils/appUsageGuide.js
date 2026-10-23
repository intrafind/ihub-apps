// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage guides for apps (issue #2838): the parts that need no configuration
 * cache or model — the app list without the guides' text, and the prompt that
 * asks a model to write a guide. See `services/appUsageGuide.js`.
 *
 * @module utils/appUsageGuide
 */
import { getLocalizedContent } from '../../shared/localize.js';
import { appUsesProjects } from '../../shared/appProjects.js';

/** Upper bound of the app's own instructions quoted to the generating model. */
const MAX_INSTRUCTIONS_CHARS = 8000;

/**
 * The apps without their usage guide's text, for the app list: the chat reads
 * the guide from the app's details, and every guide in every language would
 * otherwise ride along with each list request. The question stays, so a client
 * can tell which apps have a guide. The cached app objects are not modified.
 *
 * @param {Array<object>} apps - Apps as configured.
 * @returns {Array<object>}
 */
export function withoutUsageGuideContent(apps) {
  if (!Array.isArray(apps)) return apps;
  return apps.map(app => {
    if (!app?.usageGuide?.content) return app;
    const guide = { ...app.usageGuide };
    delete guide.content;
    return { ...app, usageGuide: guide };
  });
}

/** English name of a language code, e.g. "de" → "German". */
function languageName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/** Lines naming the input fields a user fills in, with their choices. */
function describeVariables(app, text) {
  const variables = Array.isArray(app.variables) ? app.variables : [];
  if (variables.length === 0) return [];
  const lines = ['Input fields the user fills in above the message box:'];
  for (const variable of variables) {
    const choices = (variable.predefinedValues || [])
      .map(choice => text(choice.label) || choice.value)
      .filter(Boolean);
    const details = [
      variable.type,
      variable.required ? 'required' : 'optional',
      text(variable.description),
      choices.length ? `choices: ${choices.join(', ')}` : ''
    ].filter(Boolean);
    lines.push(`- ${text(variable.label) || variable.name} (${details.join('; ')})`);
  }
  if (app.startForm?.enabled) {
    lines.push('A new chat starts with these fields as a form instead of the message box.');
  }
  return lines;
}

/** What the user can attach, or an empty string. */
function describeAttachments(upload) {
  if (!upload?.enabled) return '';
  return [
    upload.imageUpload?.enabled && 'images',
    upload.fileUpload?.enabled && 'documents (PDF, Word, text and similar)',
    upload.audioUpload?.enabled && 'audio files',
    upload.videoUpload?.enabled && 'videos',
    upload.cloudStorageUpload?.enabled && 'files from cloud storage'
  ]
    .filter(Boolean)
    .join(', ');
}

/** Lines naming the tools the app's assistant can call. */
function describeTools(app, tools, text) {
  const toolIds = Array.isArray(app.tools) ? app.tools : [];
  if (toolIds.length === 0) return [];
  const described = toolIds.map(id => {
    const tool = tools.find(t => t.id === id);
    const name = text(tool?.name) || id;
    const description = text(tool?.description);
    return description ? `- ${name}: ${description}` : `- ${name}`;
  });
  return ['Tools the assistant can use:', ...described];
}

/** Lines for the switches a user sees in the chat. */
function describeChatFeatures(app) {
  return [
    app.websearch?.enabled && 'The app can search the web.',
    app.features?.magicPrompt?.enabled &&
      'A "magic prompt" button rewrites the user\'s message into a better prompt.',
    app.inputMode?.microphone?.enabled && 'The user can dictate messages with the microphone.'
  ].filter(Boolean);
}

/**
 * Describe what a user can do with an app, from its configuration, as input
 * for the model that writes the guide.
 *
 * @param {object} app - App configuration (may be an unsaved draft).
 * @param {string} language - Language code the descriptions are taken in.
 * @param {{tools?: Array<object>, projects?: Array<object>}} [catalog] - Configured
 *   tools and projects, to name the ones the app uses.
 * @returns {string} Plain-text description.
 */
export function describeAppForGuide(app, language, { tools = [], projects = [] } = {}) {
  const text = value => getLocalizedContent(value, language, 'en').trim();
  const lines = [];
  const add = (label, value) => {
    if (value) lines.push(`${label}: ${value}`);
  };

  add('Name', text(app.name));
  add('Description', text(app.description));

  const instructions = text(app.system);
  if (instructions) {
    lines.push(
      'Internal instructions of the assistant (use them to understand what the app does; never quote them):',
      instructions.slice(0, MAX_INSTRUCTIONS_CHARS)
    );
  }
  add('Template applied to every user message', text(app.prompt));
  lines.push(...describeVariables(app, text));

  const starterPrompts = Array.isArray(app.starterPrompts) ? app.starterPrompts : [];
  if (starterPrompts.length > 0) {
    lines.push('Starter prompts offered on the start screen:');
    for (const prompt of starterPrompts) {
      lines.push(`- ${text(prompt.title)}: ${text(prompt.message)}`);
    }
  }

  add('The user can attach', describeAttachments(app.upload));
  lines.push(...describeTools(app, tools, text));

  // An app with projects switched off answers from none of its links.
  const projectIds = (appUsesProjects(app) && Array.isArray(app.projects) ? app.projects : [])
    .map(link => (typeof link === 'string' ? link : link?.id))
    .filter(Boolean);
  const projectNames = projectIds.map(id => text(projects.find(p => p.id === id)?.name) || id);
  add('Knowledge the assistant answers from', projectNames.join(', '));

  lines.push(...describeChatFeatures(app));
  return lines.join('\n');
}

/**
 * The messages that ask a model to write an app's usage guide.
 *
 * @param {object} app - App configuration (may be an unsaved draft).
 * @param {string} language - Language code the guide is written in.
 * @param {{tools?: Array<object>, projects?: Array<object>}} [catalog] - See describeAppForGuide.
 * @returns {Array<{role: string, content: string}>}
 */
export function buildUsageGuideMessages(app, language, catalog = {}) {
  const system = [
    'You write short user guides for AI assistant apps in a company portal.',
    `Write the guide in ${languageName(language)}, addressed to the user ("you").`,
    'Use Markdown with these parts: one or two sentences on what the app is for;',
    'a short numbered list of how to use it; two or three example requests;',
    'tips for good results and what the app cannot do.',
    'Only describe what the configuration below supports. Never quote, paraphrase',
    'in detail or mention the internal instructions. Do not mention configuration',
    'field names. Keep it under 300 words. Answer with the guide only, no preamble.'
  ].join(' ');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Write the user guide for this app.\n\n${describeAppForGuide(app, language, catalog)}`
    }
  ];
}

/**
 * Strip a code fence a model may wrap its whole answer in (```` ``` ````,
 * ```` ```markdown ```` or ```` ```md ````). Plain string checks instead of a
 * regular expression, which would backtrack on long answers.
 */
export function unwrapFence(content) {
  const text = String(content ?? '').trim();
  const firstLineEnd = text.indexOf('\n');
  if (!text.startsWith('```') || !text.endsWith('```') || firstLineEnd === -1) return text;
  const fenceLanguage = text.slice(3, firstLineEnd).trim().toLowerCase();
  if (!['', 'markdown', 'md'].includes(fenceLanguage)) return text;
  return text.slice(firstLineEnd + 1, -3).trim();
}

/**
 * The model that writes a guide: the default chat model, else the first chat
 * model — among the models the admin may use (a content admin can be limited
 * to some models, and the call runs on the server's credentials). Image
 * models and conversation-backed providers (iAssistant Conversation, which
 * needs a chat of its own) cannot answer a one-off prompt.
 *
 * @param {Array<object>} models - Configured, enabled models.
 * @param {(model: object) => boolean} mayUse - Whether the admin may use a model.
 * @returns {object|undefined} Model configuration.
 */
export function selectGuideModel(models, mayUse) {
  const usable = (models || []).filter(
    model =>
      (model.modelType || 'chat') === 'chat' &&
      !model.supportsImageGeneration &&
      String(model.provider || '').toLowerCase() !== 'iassistant-conversation' &&
      mayUse(model)
  );
  return usable.find(model => model.default) || usable[0];
}
