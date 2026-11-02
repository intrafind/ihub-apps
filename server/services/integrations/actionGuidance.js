// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How an action is described to the model and how to use it (#2974).
 *
 * Three texts per action, each from the installation's admin override
 * (`actions.overrides[action]`) when there is one, else from the definition
 * (or, for MCP and A2A, from the server):
 *
 * - `description`: the tool description the model reads.
 * - `guidance`: model guidance added to the **system prompt** while the
 *   integration is active in a chat (one block per installation, see
 *   {@link buildIntegrationGuidance}). It is not part of the tool
 *   description, so it does not change the action's fingerprint (#2916).
 * - `examples`: example prompts shown to admins (and later to users, #2922).
 *
 * One level up, the installation's `instructions` override the definition's
 * `instructions` (an MCP server's own `instructions`, a connector's guidance).
 *
 * @module services/integrations/actionGuidance
 */
import { localized } from './definitions/installedValues.js';

/** Most characters of the guidance block one chat turn adds to the system prompt. */
export const MAX_GUIDANCE_BLOCK_CHARS = 12_000;

/**
 * The admin override of one action, or an empty object.
 * @param {Object|null} instance
 * @param {string} actionName
 * @returns {{description?: Object|string, guidance?: Object|string, examples?: Array, sideEffect?: string, dataFlow?: string}}
 */
export function actionOverrideOf(instance, actionName) {
  const override = instance?.actions?.overrides?.[actionName];
  return override && typeof override === 'object' ? override : {};
}

/** A localized override text, or '' when the override has none for the language. */
function overrideText(value, language) {
  if (value === undefined || value === null) return '';
  return localized(value, language, '') || '';
}

/**
 * An action as `discoverActions` returned it, with the installation's text
 * overrides applied. The definition's (or the server's) own texts stay
 * available as `defaults`, and `overridden` says which ones an admin set.
 *
 * @param {Object} action - a `discoverActions` result
 * @param {Object|null} instance - the installation
 * @param {string} [language='en']
 * @returns {Object} the action with `description`, `guidance`, `examples`,
 *   `defaults: { description, guidance, examples }` and
 *   `overridden: { description, guidance, examples }`
 *
 * @example
 * withActionOverrides(
 *   { name: 'search', description: 'Search issues', guidance: '', examples: [] },
 *   { actions: { overrides: { search: { guidance: { en: 'Use JQL.' } } } } },
 *   'en'
 * ).guidance // 'Use JQL.'
 */
export function withActionOverrides(action, instance, language = 'en') {
  const override = actionOverrideOf(instance, action?.name);
  const defaults = {
    description: action?.description || '',
    guidance: action?.guidance || '',
    examples: Array.isArray(action?.examples) ? action.examples.filter(Boolean) : []
  };
  const description = overrideText(override.description, language);
  const guidance = overrideText(override.guidance, language);
  const examples = Array.isArray(override.examples)
    ? override.examples.map(example => overrideText(example, language)).filter(Boolean)
    : null;
  return {
    ...action,
    description: description || defaults.description,
    guidance: guidance || defaults.guidance,
    examples: examples || defaults.examples,
    defaults,
    overridden: {
      description: Boolean(description),
      guidance: Boolean(guidance),
      examples: examples !== null
    }
  };
}

/**
 * The integration-level model guidance of an installation: the admin's
 * `instructions`, else the definition's, else what the system itself sent
 * (an MCP server's `instructions`).
 *
 * @param {Object|null} definition
 * @param {Object|null} instance
 * @param {string} [language='en']
 * @param {string|null} [fromSystem] - the system's own instructions, when known
 * @returns {{text: string, source: 'admin'|'definition'|'server'|null}}
 */
export function integrationInstructionsOf(
  definition,
  instance,
  language = 'en',
  fromSystem = null
) {
  const own = overrideText(instance?.instructions, language);
  if (own) return { text: own, source: 'admin' };
  const declared = localized(definition?.instructions, language, '') || '';
  if (declared) return { text: declared, source: 'definition' };
  if (typeof fromSystem === 'string' && fromSystem.trim()) {
    return { text: fromSystem.trim(), source: 'server' };
  }
  return { text: '', source: null };
}

/** Escape a value for an XML-ish attribute of the guidance block. */
function attribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A label of a tool's installation as text (labels may still be localized objects). */
function labelOf(tool) {
  const label = tool?._integration?.instanceLabel;
  if (typeof label === 'string' && label) return label;
  if (label && typeof label === 'object') return localized(label, 'en', '') || '';
  return String(tool?._integration?.instanceId || '');
}

/**
 * The guidance block for the system prompt of one turn: one
 * `<integration-guidance>` element per installation whose tools the turn
 * offers, with the installation's instructions and the guidance of each
 * offered action that has one. Empty when no offered tool brings guidance.
 *
 * Only the tools the turn really offers count: an action switched off, not
 * bound by the app or not granted to the user adds nothing.
 *
 * @param {Array<Object>} tools - the turn's tools (`getToolsForApp` result)
 * @returns {string}
 */
export function buildIntegrationGuidance(tools) {
  const byInstance = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const marker = tool?._integration;
    if (!marker?.instanceId) continue;
    let entry = byInstance.get(marker.instanceId);
    if (!entry) {
      entry = { label: labelOf(tool), instructions: '', actions: [] };
      byInstance.set(marker.instanceId, entry);
    }
    if (!entry.instructions && typeof tool.instructions === 'string') {
      entry.instructions = tool.instructions.trim();
    }
    const guidance = typeof marker.guidance === 'string' ? marker.guidance.trim() : '';
    if (guidance) {
      entry.actions.push({
        title: marker.actionTitle || marker.action,
        toolId: tool.id,
        guidance
      });
    }
  }
  const blocks = [];
  for (const [instanceId, entry] of byInstance) {
    if (!entry.instructions && entry.actions.length === 0) continue;
    const lines = [];
    if (entry.instructions) lines.push(entry.instructions);
    for (const action of entry.actions) {
      lines.push(`- ${action.title} (tool \`${action.toolId}\`): ${action.guidance}`);
    }
    blocks.push(
      `<integration-guidance integration="${attribute(entry.label)}" id="${attribute(instanceId)}">\n${lines.join('\n')}\n</integration-guidance>`
    );
  }
  if (blocks.length === 0) return '';
  const text = `How to use the connected integrations:\n${blocks.join('\n')}`;
  return text.length > MAX_GUIDANCE_BLOCK_CHARS ? text.slice(0, MAX_GUIDANCE_BLOCK_CHARS) : text;
}

/**
 * Append the integration guidance of the turn's tools to its system message
 * (or add a system message when there is none). Idempotent: a system prompt
 * that already holds the block is left alone.
 *
 * @param {Array<Object>} llmMessages - the prepared messages (mutated in place)
 * @param {Array<Object>} tools - the turn's tools
 * @returns {boolean} true when guidance was added
 */
export function appendIntegrationGuidance(llmMessages, tools) {
  if (!Array.isArray(llmMessages)) return false;
  const block = buildIntegrationGuidance(tools);
  if (!block) return false;
  const systemMessage = llmMessages.find(m => m.role === 'system');
  if (!systemMessage) {
    llmMessages.unshift({ role: 'system', content: block });
    return true;
  }
  if (typeof systemMessage.content !== 'string') return false;
  if (systemMessage.content.includes(block)) return false;
  systemMessage.content = systemMessage.content ? `${systemMessage.content}\n\n${block}` : block;
  return true;
}
