// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { APP_ID_MAX_LENGTH, APP_ID_PATTERN } from '../../../shared/validationPatterns.js';
import { localized } from './definitions/installedValues.js';
import { bindingKeyOfType } from './integrationTypes.js';

/**
 * Example apps of an integration (concept "Example apps and chat test for
 * integrations", issue #3128).
 *
 * A definition ships example apps as companion JSON files
 * (`exampleApps[].file`, an ordinary app configuration that binds the
 * integration by its definition id or type). On the page of an installation
 * the admin turns one into an app for *that* installation; a definition
 * without example apps gets a generated assistant built from its name,
 * description, instructions and action examples.
 *
 * Everything here is pure: the route reads the templates
 * (`IntegrationRegistry.readExampleApp`) and writes the app.
 *
 * @module services/integrations/exampleApps
 */

/** The key of the generated template (the shipped ones are keyed by their file). */
export const GENERATED_TEMPLATE = 'generated';

const LANGUAGES = ['en', 'de'];

/** The most starter prompts a generated app gets from the action examples. */
const MAX_GENERATED_STARTERS = 3;

/**
 * A localized value as an `{ en, de }` object; a plain string is used for both.
 * @param {string|Object|undefined} value
 * @param {string} [fallback]
 * @returns {Record<string, string>}
 */
function bothLanguages(value, fallback = '') {
  const out = {};
  for (const lang of LANGUAGES) out[lang] = localized(value, lang, fallback);
  return out;
}

/**
 * Fit a candidate into an app id: lowercase, allowed characters only, not
 * longer than the app id limit.
 * @param {string} value
 * @returns {string}
 */
export function toAppId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, APP_ID_MAX_LENGTH)
    .replace(/[-._]+$/g, '');
}

/** Whether a string is a valid app id. */
export function isValidAppId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= APP_ID_MAX_LENGTH &&
    APP_ID_PATTERN.test(id)
  );
}

/**
 * The id the example app gets unless the admin types another: the
 * template's id when it is free, else `<templateId>-<instanceId>`, else that
 * with a numeric suffix.
 *
 * @param {string} templateId - the template's id (or the generated one)
 * @param {string} instanceId - the installation
 * @param {(id: string) => boolean} isTaken - whether an app id is in use (case-insensitive)
 * @returns {string}
 */
export function suggestAppId(templateId, instanceId, isTaken) {
  const base = toAppId(templateId) || toAppId(`${instanceId}-assistant`) || 'example-app';
  if (!isTaken(base)) return base;
  const combined = toAppId(base.endsWith(instanceId) ? base : `${base}-${instanceId}`) || base;
  if (!isTaken(combined)) return combined;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${combined.slice(0, APP_ID_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${combined.slice(0, APP_ID_MAX_LENGTH - 14)}-${Date.now()}`;
}

/**
 * The template's binding of this integration, re-keyed to the installation:
 * a binding keyed by the definition id or by `type:<its type>` moves to the
 * installation id and keeps its settings (`actions`, `required`, scopes);
 * other bindings stay. A template without one binds the installation with
 * `{}`.
 *
 * @param {Object|undefined} integrations - the template's `integrations`
 * @param {Object} definition - the installation's definition
 * @param {string} instanceId
 * @returns {Object} the app's new `integrations`
 */
export function bindToInstallation(integrations, definition, instanceId) {
  const genericKeys = new Set([definition.id]);
  if (definition.type) genericKeys.add(bindingKeyOfType(definition.type));
  const out = {};
  let binding = null;
  for (const [key, value] of Object.entries(integrations || {})) {
    if (genericKeys.has(key) || key === instanceId) {
      // The first match wins; a template binds its integration once.
      binding ??= value && typeof value === 'object' ? { ...value } : {};
      continue;
    }
    out[key] = value;
  }
  out[instanceId] = binding || {};
  return out;
}

/**
 * An assistant built from what the definition says, for a definition that
 * ships no example app.
 *
 * @param {Object} definition - the installation's definition
 * @param {Object} instance - the installation
 * @returns {Object} an app configuration (id and `enabled` are set later)
 */
export function generatedExampleApp(definition, instance) {
  const label = bothLanguages(instance.label, '');
  const name = bothLanguages(definition.name, definition.id);
  for (const lang of LANGUAGES) label[lang] ||= name[lang];
  const description = bothLanguages(definition.description, '');
  const instructions = bothLanguages(definition.instructions, '');

  const system = {
    en: [
      `You answer with the tools of the integration "${label.en}"${description.en ? `: ${description.en}` : '.'}`,
      'Use the tools for every question they can answer, and say so when they cannot. Base your answers on what the tools return; never invent results. Answer in the language of the user.',
      instructions.en ? `## About the integration\n${instructions.en}` : ''
    ]
      .filter(Boolean)
      .join('\n\n'),
    de: [
      `Du antwortest mit den Tools der Integration „${label.de}“${description.de ? `: ${description.de}` : '.'}`,
      'Nutze die Tools für jede Frage, die sie beantworten können, und sag es, wenn sie es nicht können. Stütze deine Antworten auf das, was die Tools liefern; erfinde nie Ergebnisse. Antworte in der Sprache des Benutzers.',
      instructions.de ? `## Zur Integration\n${instructions.de}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  };

  const starterPrompts = [];
  for (const action of definition.actions || []) {
    if (starterPrompts.length >= MAX_GENERATED_STARTERS) break;
    if (action.enabledByDefault === false) continue;
    const example = (action.examples || [])[0];
    if (!example) continue;
    const message = bothLanguages(example, '');
    if (!message.en && !message.de) continue;
    starterPrompts.push({
      title: bothLanguages(action.title, action.name),
      message
    });
  }

  const app = {
    id: `${instance.id}-assistant`,
    order: 100,
    category: 'utility',
    type: 'chat',
    icon: 'link',
    color: '#4F46E5',
    name: label,
    description: {
      en: description.en || `Try the integration ${label.en} in a chat`,
      de: description.de || `Die Integration ${label.de} im Chat ausprobieren`
    },
    system,
    greeting: {
      en: {
        title: label.en,
        subtitle: 'Ask a question the integration can answer.'
      },
      de: {
        title: label.de,
        subtitle: 'Stellen Sie eine Frage, die die Integration beantworten kann.'
      }
    },
    sendChatHistory: true,
    preferredOutputFormat: 'markdown',
    integrations: {}
  };
  if (starterPrompts.length) app.starterPrompts = starterPrompts;
  return app;
}

/**
 * Append the installation's label to an app name: `"Open Data Assistant
 * (GovData)"`. Used when the template's id is taken, so two apps of one
 * template are told apart.
 *
 * @param {string|Object} name
 * @param {string|Object} label - the installation label
 * @returns {string|Object}
 */
export function nameForInstallation(name, label) {
  if (!label) return name;
  if (typeof name === 'string') {
    const suffix = localized(label, 'en');
    return suffix && !name.includes(suffix) ? `${name} (${suffix})` : name;
  }
  const out = { ...name };
  for (const [lang, text] of Object.entries(name || {})) {
    const suffix = localized(label, lang);
    if (suffix && typeof text === 'string' && !text.includes(suffix)) {
      out[lang] = `${text} (${suffix})`;
    }
  }
  return out;
}

/**
 * Turn a template into the app for one installation.
 *
 * @param {Object} params
 * @param {Object} params.template - the template app (shipped or generated)
 * @param {Object} params.definition - the installation's definition
 * @param {Object} params.instance - the installation (`id`, `label`)
 * @param {string} params.appId - the id the app gets
 * @param {boolean} params.enabled - whether the app is enabled
 * @param {boolean} [params.renamed] - the template's id was taken: name the installation
 * @returns {Object} the app configuration to validate and write
 */
export function buildExampleApp({ template, definition, instance, appId, enabled, renamed }) {
  const app = structuredClone(template);
  // Fields a template must not carry over: they belong to an app's history
  // or its inheritance, not to a new app.
  for (const key of ['parentId', 'inheritanceLevel', 'overriddenFields']) delete app[key];
  app.id = appId;
  app.enabled = enabled;
  app.integrations = bindToInstallation(template.integrations, definition, instance.id);
  if (renamed && app.name) {
    app.name = nameForInstallation(app.name, instance.label || instance.id);
  }
  return app;
}

/**
 * How the admin UI lists a template.
 *
 * @param {string} key - the template's file, or `generated`
 * @param {Object} template - the template app
 * @param {string} language
 * @param {string} suggestedId - from {@link suggestAppId}
 * @returns {{ key: string, source: 'definition'|'generated', templateId: string, name: string, description: string, suggestedId: string }}
 */
export function templateView(key, template, language, suggestedId) {
  return {
    key,
    source: key === GENERATED_TEMPLATE ? 'generated' : 'definition',
    templateId: template.id || '',
    name: localized(template.name, language, template.id || key),
    description: localized(template.description, language),
    icon: typeof template.icon === 'string' ? template.icon : null,
    color: typeof template.color === 'string' ? template.color : null,
    suggestedId
  };
}
