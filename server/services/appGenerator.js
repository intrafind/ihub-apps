// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The brief the app creation wizard sends to the model that drafts an app
 * (Admin → Apps → New → Generate with AI): the `app-generator` prompt, the
 * installed integrations the app may bind, and the schema of the answer.
 *
 * An app has no tool list (#3275): it gets tools from the integrations it
 * binds. The generator therefore lists the enabled installations (id, name,
 * type, actions) and may only pick from them; the answer's `integrations` is
 * an array of `{ id, actions? }` that the wizard turns into the app's
 * `integrations` object.
 *
 * @module services/appGenerator
 */

import { getLocalizedString } from '../utils/localize.js';

export { integrationsFromAnswer } from '../../shared/appGenerator.js';

/** The part of the generator's answer that picks integrations. */
const INTEGRATIONS_PROPERTY = 'integrations';

/** Most actions listed per integration, so the brief stays small. */
const MAX_LISTED_ACTIONS = 12;

/**
 * The enabled installed integrations as the brief describes them.
 *
 * @param {Array<{ instance: Object, definition: Object, label?: string }>} resolved
 *   `installedIntegrationService.resolveAllEnabled(language)`
 * @param {string} language
 * @returns {Array<{ id: string, label: string, type: string|null, description: string, actions: string[] }>}
 */
export function describeInstalledIntegrations(resolved, language) {
  return (Array.isArray(resolved) ? resolved : [])
    .filter(entry => entry?.instance?.id && entry?.definition)
    .map(({ instance, definition, label }) => ({
      id: instance.id,
      label: label || getLocalizedString(definition.name, language, 'en', instance.id),
      type: definition.type || null,
      description: getLocalizedString(definition.description, language, 'en', ''),
      actions: (definition.actions || []).map(action => action.name).filter(Boolean)
    }));
}

/**
 * The prompt block that lists the integrations the app may bind.
 * @param {ReturnType<typeof describeInstalledIntegrations>} integrations
 * @returns {string} empty when nothing is installed
 */
export function integrationsBlock(integrations) {
  if (integrations.length === 0) return '';
  const lines = integrations.map(integration => {
    const actions = integration.actions.slice(0, MAX_LISTED_ACTIONS).join(', ');
    const more = integration.actions.length > MAX_LISTED_ACTIONS ? ', …' : '';
    const description = integration.description
      ? ` — ${integration.description.slice(0, 160)}`
      : '';
    return `- ${integration.id} (${integration.label}${integration.type ? `, ${integration.type}` : ''})${description}. Actions: ${actions}${more}`;
  });
  return [
    '',
    'INTEGRATIONS:',
    "An app has no list of tools. It gets tools from the integrations it binds. Bind an integration only when the described app needs what it does, and only one of these installed integrations (use its id exactly; leave `integrations` out otherwise). Name `actions` only to offer fewer than all of an integration's actions:",
    ...lines,
    'For plain web search do not bind an integration: set "websearch": { "enabled": true } instead.'
  ].join('\n');
}

/**
 * The schema of the generator's answer, with `integrations` limited to the
 * installed ones. Without any installed integration the property is left out.
 *
 * @param {Object} outputSchema - the prompt's own schema
 * @param {ReturnType<typeof describeInstalledIntegrations>} integrations
 * @returns {Object}
 */
export function schemaWithIntegrations(outputSchema, integrations) {
  const schema = structuredClone(outputSchema || { type: 'object', properties: {} });
  if (integrations.length === 0) return schema;
  schema.properties = {
    ...(schema.properties || {}),
    [INTEGRATIONS_PROPERTY]: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: integrations.map(integration => integration.id) },
          actions: { type: 'array', items: { type: 'string' } }
        },
        required: ['id']
      }
    }
  };
  return schema;
}

/**
 * The brief for one language.
 *
 * @param {Object} promptConfig - the `app-generator` prompt (`prompt`, `outputSchema`)
 * @param {string} language
 * @param {string} defaultLanguage
 * @param {ReturnType<typeof describeInstalledIntegrations>} integrations
 * @returns {{ prompt: string, outputSchema: Object }}
 */
export function buildAppGeneratorBrief(promptConfig, language, defaultLanguage, integrations) {
  const text = promptConfig?.prompt?.[language] || promptConfig?.prompt?.[defaultLanguage] || '';
  return {
    prompt: text + integrationsBlock(integrations),
    outputSchema: schemaWithIntegrations(promptConfig?.outputSchema, integrations)
  };
}
