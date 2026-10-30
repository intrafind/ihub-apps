// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `a2a` protocol: an installed integration whose actions are the skills a
 * remote agent's Agent Card lists. A thin layer over `A2aClientManager`,
 * which keeps the card cache, the conversations and the task handling; the
 * manager is fed from the installations (`agentConfig.js`).
 *
 * The tools keep their ids (`a2a__<instanceId>__<skill>`) and their `_a2a`
 * marker; `_integration` is added so the binding, the groups and the action
 * policy apply like to any other integration.
 */
import a2aClientManager from '../../../a2a/A2aClientManager.js';
import { actionEnabled, testResult } from '../common.js';
import { effectiveValues, instanceLabel } from '../../definitions/installedValues.js';
import { agentConfigFor } from './agentConfig.js';

export const dynamicActions = true;
export const supportedAuthModes = ['none', 'service-account', 'oauth-client'];

function actionOf(skill, instance) {
  const enabled = actionEnabled(instance, { name: skill.id, enabledByDefault: true });
  return {
    name: skill.id,
    toolId: skill.toolId,
    title: skill.name || skill.id,
    description: skill.description || '',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to ask the agent' },
        data: {
          type: 'object',
          description: 'Optional structured input',
          additionalProperties: true
        }
      },
      required: ['message']
    },
    // An agent may act on a request; nothing in the card says how.
    sideEffect: 'unknown',
    dataFlow: 'external',
    enabledByDefault: true,
    enabled,
    requirementsMet: true,
    needsToken: false,
    available: enabled,
    guidance: '',
    examples: Array.isArray(skill.examples) ? skill.examples : []
  };
}

/** Every skill of the agent's card, the switched-off ones included. */
export async function discoverActions({ instance }) {
  const skills = await a2aClientManager.allSkillsOfAgent(instance.id);
  return skills.map(skill => actionOf(skill, instance));
}

/** The model-facing tools: the manager's `_a2a` tools with the `_integration` marker added. */
export async function discoverTools(resolved, language = 'en') {
  const { instance, definition } = resolved;
  const tools = await a2aClientManager.toolsOfAgent(instance.id);
  const label = instanceLabel(definition, instance, language);
  return tools.map(tool => ({
    ...tool,
    type: 'integration',
    _integration: {
      instanceId: instance.id,
      instanceLabel: label,
      action: tool._a2a?.skillId || tool.name,
      definition: definition.id
    }
  }));
}

/** Run a skill as the calling user; the chat turn's abort signal cancels the task. */
export async function run({ context }) {
  const toolId = context?.tool?.id;
  if (!toolId) throw new Error('A2A action call without a tool id');
  return a2aClientManager.callTool(toolId, context.params || {}, {
    signal: context.options?.signal
  });
}

/** Fetch the card of the installation (saved or a draft) and list its skills. */
export async function test({ definition, instance }) {
  const started = Date.now();
  const steps = [];
  const push = (id, label, status, message, extra = {}) =>
    steps.push({ id, label, status, message, ...extra });
  const projected = agentConfigFor({
    definition,
    instance,
    values: effectiveValues(definition, instance)
  });
  if (!projected.ok) {
    push(
      'settings',
      'Agent settings',
      'fail',
      projected.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
    return testResult(steps, started);
  }
  push('settings', 'Agent settings', 'ok', projected.config.cardUrl);
  let probe;
  try {
    probe = await a2aClientManager.testConfig(projected.config);
  } catch (error) {
    push('card', 'Agent Card', 'fail', error.message, {
      details: error.details ? { issues: error.details } : undefined
    });
    return testResult(steps, started);
  }
  const card = probe.card || {};
  push('card', 'Agent Card', 'ok', `${card.name || 'agent'} ${card.version || ''}`.trim(), {
    details: { url: card.url, protocolVersion: card.protocolVersion, streaming: card.streaming }
  });
  const skills = Array.isArray(probe.skills) ? probe.skills : [];
  push('skills', 'Skills', skills.length ? 'ok' : 'warn', `${skills.length} skills listed`);
  return {
    ...testResult(steps, started, {
      actionCount: skills.length,
      successMessage: `Agent Card read, ${skills.length} skills listed`
    }),
    actions: skills.map(skill => ({
      ...actionOf(skill, instance),
      enabled: skill.allowed !== false,
      available: skill.allowed !== false
    }))
  };
}

/** Connection status of an installation, for the admin list. */
export function status(instance) {
  const entry = a2aClientManager.status().find(s => s.id === instance.id);
  if (!entry) return null;
  return {
    connected: entry.connected,
    unhealthy: entry.unhealthy,
    lastError: entry.lastError || null,
    toolCount: entry.toolCount
  };
}

export function invalidate() {}
