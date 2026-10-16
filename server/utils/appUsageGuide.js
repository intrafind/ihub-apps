/**
 * Usage guides for apps (issue #2838): the parts that need no configuration
 * cache or model — the app list without the guides' text, and the prompt that
 * asks a model to write a guide. See `services/appUsageGuide.js`.
 *
 * @module utils/appUsageGuide
 */
import { getLocalizedContent } from '../../shared/localize.js';

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
    const { content: _content, ...guide } = app.usageGuide;
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

/**
 * Describe what a user can do with an app, from its configuration, as input
 * for the model that writes the guide.
 *
 * @param {object} app - App configuration (may be an unsaved draft).
 * @param {string} language - Language code the descriptions are taken in.
 * @param {{tools?: Array<object>, sources?: Array<object>}} [catalog] - Configured
 *   tools and sources, to name the ones the app uses.
 * @returns {string} Plain-text description.
 */
export function describeAppForGuide(app, language, { tools = [], sources = [] } = {}) {
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

  const variables = Array.isArray(app.variables) ? app.variables : [];
  if (variables.length > 0) {
    lines.push('Input fields the user fills in above the message box:');
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
  }
  if (app.startForm?.enabled) {
    lines.push('A new chat starts with these fields as a form instead of the message box.');
  }

  const starterPrompts = Array.isArray(app.starterPrompts) ? app.starterPrompts : [];
  if (starterPrompts.length > 0) {
    lines.push('Starter prompts offered on the start screen:');
    for (const prompt of starterPrompts) {
      lines.push(`- ${text(prompt.title)}: ${text(prompt.message)}`);
    }
  }

  const upload = app.upload?.enabled ? app.upload : null;
  if (upload) {
    const kinds = [
      upload.imageUpload?.enabled && 'images',
      upload.fileUpload?.enabled && 'documents (PDF, Word, text and similar)',
      upload.audioUpload?.enabled && 'audio files',
      upload.videoUpload?.enabled && 'videos',
      upload.cloudStorageUpload?.enabled && 'files from cloud storage'
    ].filter(Boolean);
    if (kinds.length > 0) add('The user can attach', kinds.join(', '));
  }

  if (app.websearch?.enabled) lines.push('The app can search the web.');

  const toolIds = Array.isArray(app.tools) ? app.tools : [];
  if (toolIds.length > 0) {
    const described = toolIds.map(id => {
      const tool = tools.find(t => t.id === id);
      const name = text(tool?.name) || id;
      const description = text(tool?.description);
      return description ? `- ${name}: ${description}` : `- ${name}`;
    });
    lines.push('Tools the assistant can use:', ...described);
  }

  const sourceIds = Array.isArray(app.sources) ? app.sources : [];
  if (sourceIds.length > 0) {
    const names = sourceIds
      .map(id => text(sources.find(s => s.id === id)?.name) || id)
      .filter(Boolean);
    add('Knowledge the assistant answers from', names.join(', '));
  }

  if (app.features?.magicPrompt?.enabled) {
    lines.push('A "magic prompt" button rewrites the user\'s message into a better prompt.');
  }
  if (app.inputMode?.microphone?.enabled) {
    lines.push('The user can dictate messages with the microphone.');
  }

  return lines.join('\n');
}

/**
 * The messages that ask a model to write an app's usage guide.
 *
 * @param {object} app - App configuration (may be an unsaved draft).
 * @param {string} language - Language code the guide is written in.
 * @param {{tools?: Array<object>, sources?: Array<object>}} [catalog] - See describeAppForGuide.
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

/** Strip a code fence a model may wrap its whole answer in. */
export function unwrapFence(content) {
  const match = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(content);
  return (match ? match[1] : content).trim();
}
