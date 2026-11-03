// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The detail of one action of an installed integration (#2974), as
 * `GET /api/admin/integrations/installed/:id/actions/:action` answers with
 * it: what the model sees, where its side effect, data flow and approval
 * come from, how to use it, who binds it, and its usage.
 *
 * The approval is resolved by the same resolver the tool loader stamps every
 * tool with (`utils/toolApproval.js`), on a tool definition built the way the
 * tool loader builds it, so the detail cannot drift from what a chat does.
 *
 * @module services/integrations/actionDetail
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { resolveToolApproval } from '../../utils/toolApproval.js';
import { isToolSelected } from '../../utils/toolSelection.js';
import { actionReviewState } from '../../utils/actionFingerprint.js';
import { getProtocolAdapter } from './protocols/index.js';
import { localized } from './definitions/installedValues.js';
import { currentActionsOf } from './actionReview.js';
import {
  actionOverrideOf,
  integrationInstructionsOf,
  withActionOverrides
} from './actionGuidance.js';
import { readActionUsage } from './actionUsage.js';

const COMPONENT = 'ActionDetail';

/** Most bindings of each kind the detail lists. */
const MAX_BINDINGS = 100;

/**
 * The side effect an OpenAPI operation's HTTP method suggests (GET/HEAD →
 * read, POST/PUT/PATCH → write, DELETE → destructive), or null.
 * @param {string|null|undefined} method
 * @returns {'read'|'write'|'destructive'|null}
 */
export function sideEffectOfMethod(method) {
  switch (String(method || '').toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'read';
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 'write';
    case 'DELETE':
      return 'destructive';
    default:
      return null;
  }
}

/**
 * The tool definition the tool loader would build for an action, enough for
 * the approval resolver and the source producers.
 *
 * @param {Object} resolved - `installedIntegrationService.resolve()` result
 * @param {Object} action - a `discoverActions` result
 * @param {string|null} fingerprint
 * @returns {Object}
 */
export function toolDefinitionOf(resolved, action, fingerprint = null) {
  const { instance, definition } = resolved;
  const protocol = definition.protocol.type;
  const listed = (definition.actions || []).find(a => a.name === action.name);
  const tool = {
    id: action.toolId || `${instance.id}__${action.name}`,
    type: 'integration',
    dataFlow: action.dataFlow,
    sources: action.sources,
    _integration: {
      instanceId: instance.id,
      action: action.name,
      definition: definition.id,
      ...(fingerprint ? { fingerprint } : {})
    }
  };
  if (protocol === 'mcp') {
    tool._mcp = {
      serverId: instance.id,
      originalName: action.name,
      annotations: action.annotations
    };
  } else if (protocol === 'a2a') {
    tool._a2a = { agentId: instance.id, skillId: action.name };
  } else {
    // The declared side effect (the override is applied by the resolver).
    tool.sideEffect = listed?.sideEffect || action.sideEffect;
    tool.readOnly = tool.sideEffect === 'read';
  }
  return tool;
}

/**
 * Where the data flow comes from: `admin` (override), `definition`, or
 * `protocol` (remote MCP servers and A2A agents are external).
 * @param {Object} toolDef
 * @param {Object} instance
 * @returns {'admin'|'definition'|'protocol'|'default'}
 */
function dataFlowSourceOf(toolDef, instance) {
  const override = actionOverrideOf(instance, toolDef._integration.action).dataFlow;
  if (override) return 'admin';
  if (toolDef._mcp || toolDef._a2a) return 'protocol';
  if (toolDef.dataFlow) return 'definition';
  return 'default';
}

/** An app's name in one language. */
function appName(app, language) {
  return localized(app?.name, language, app?.id) || app?.id;
}

/**
 * The apps, workflows and scheduled tasks that bind an action.
 *
 * - **Apps**: by `app.integrations` (the installation, its definition or its
 *   type; an `actions` list must name the action, an action that binds only
 *   explicitly needs one), or by naming the tool in `app.tools`.
 * - **Workflows**: a node whose `config.tools` selects the tool.
 * - **Scheduled tasks**: a task whose tools select it; a task that keeps its
 *   app's tools (`enabledTools: null`) when its app binds the action.
 *
 * @param {Object} resolved
 * @param {Object} action - with `toolId` and `bindExplicitly`
 * @param {Object} toolDef
 * @param {string} language
 * @param {Object} [deps] - `{ apps, workflows, tasks }` (tests)
 * @returns {Promise<{apps: Array, workflows: Array, scheduledTasks: Array, scheduledTasksUnknown?: boolean}>}
 */
export async function bindingsOf(resolved, action, toolDef, language = 'en', deps = {}) {
  const { appBindingFor, bindingKeyFor } = await import('./integrationTools.js');
  const instance = resolved.instance;
  const allApps = deps.apps || configCache.getApps(true)?.data || [];
  const apps = [];
  const appIds = new Set();
  for (const app of allApps) {
    if (!app?.id) continue;
    const binding = appBindingFor(app, instance);
    let via = null;
    if (binding) {
      const named = Array.isArray(binding.actions);
      const binds = named ? binding.actions.includes(action.name) : !action.bindExplicitly;
      if (binds) via = bindingKeyFor(app, instance) === instance.id ? 'installation' : 'definition';
    }
    if (!via && Array.isArray(app.tools) && isToolSelected(toolDef, app.tools)) via = 'tools';
    if (!via) continue;
    appIds.add(app.id);
    if (apps.length < MAX_BINDINGS) {
      apps.push({ id: app.id, name: appName(app, language), via, enabled: app.enabled !== false });
    }
  }

  const workflows = [];
  for (const workflow of deps.workflows || configCache.getWorkflows(true)?.data || []) {
    const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
    const uses = nodes.some(
      node => Array.isArray(node?.config?.tools) && isToolSelected(toolDef, node.config.tools)
    );
    if (uses && workflows.length < MAX_BINDINGS) {
      workflows.push({
        id: workflow.id,
        name: localized(workflow.name, language, workflow.id) || workflow.id,
        enabled: workflow.enabled !== false
      });
    }
  }

  const scheduledTasks = [];
  let scheduledTasksUnknown = false;
  try {
    const tasks = deps.tasks || (await scanTasks());
    for (const task of tasks) {
      const refs = Array.isArray(task?.enabledTools) ? task.enabledTools : null;
      const uses = refs ? isToolSelected(toolDef, refs) : appIds.has(task?.appId);
      if (uses && scheduledTasks.length < MAX_BINDINGS) {
        scheduledTasks.push({
          id: task.id,
          name: task.name || task.id,
          appId: task.appId || null,
          status: task.status || null
        });
      }
    }
  } catch (error) {
    // No task store (a deployment without scheduled tasks), or it failed.
    scheduledTasksUnknown = true;
    logger.debug('Could not list the scheduled tasks for an action detail', {
      component: COMPONENT,
      error: error.message
    });
  }
  return {
    apps,
    workflows,
    scheduledTasks,
    ...(scheduledTasksUnknown ? { scheduledTasksUnknown } : {})
  };
}

/** Every stored scheduled task, or [] when the feature has no store. */
async function scanTasks() {
  const { getScheduledTaskRepository } =
    await import('../scheduler/tasks/ScheduledTaskRepository.js');
  const repository = getScheduledTaskRepository();
  if (!repository?.isAvailable?.()) return [];
  const out = [];
  for await (const task of repository.scanTasks()) out.push(task);
  return out;
}

/**
 * The connections an admin can run a test with, for this installation.
 *
 * In this release an installation has one way to sign in (`auth.mode`):
 * per user (`oauth-user`: the admin's own connection), a shared credential
 * (`service-account`, `oauth-client`: the installation's credential, with the
 * admin as the acting user where the system needs one), or none.
 *
 * @param {Object} instance
 * @returns {Array<{id: 'me'|'shared', kind: string, credentialRef?: string}>}
 */
export function testConnectionsOf(instance) {
  const mode = instance?.auth?.mode || 'none';
  if (mode === 'service-account' || mode === 'oauth-client') {
    return [
      {
        id: 'shared',
        kind: mode,
        ...(instance.auth?.credentialRef ? { credentialRef: instance.auth.credentialRef } : {})
      }
    ];
  }
  return [{ id: 'me', kind: mode === 'oauth-user' ? 'personal' : 'none' }];
}

/**
 * Whether a test of an action with this side effect needs the explicit
 * confirmation: everything but a read the server does not merely claim
 * (an untrusted MCP annotation is not a read).
 * @param {{sideEffect: string, sideEffectSource: string}} policy
 * @returns {boolean}
 */
export function testNeedsConfirmation(policy) {
  return policy?.sideEffect !== 'read' || policy?.sideEffectSource === 'annotation';
}

/**
 * Find one action of a resolved installation, with every current action's
 * fingerprint. Null when the installation offers no such action.
 *
 * @param {Object} resolved
 * @param {string} actionName
 * @param {string} language
 * @returns {Promise<{action: Object, fingerprint: string|null}|null>}
 */
export async function findAction(resolved, actionName, language = 'en') {
  const { actions, fingerprints } = await currentActionsOf(resolved, language);
  const action = actions.find(a => a.name === actionName);
  if (!action) return null;
  return { action, fingerprint: fingerprints[actionName] || null };
}

/**
 * The detail view of one action.
 *
 * @param {Object} resolved - `installedIntegrationService.resolve()` result
 * @param {string} actionName
 * @param {Object} [options]
 * @param {string} [options.language='en']
 * @param {Object} [options.platform] - platform config (default: the cache's)
 * @returns {Promise<Object|null>} null when the action does not exist
 */
export async function describeAction(resolved, actionName, options = {}) {
  const language = options.language || 'en';
  const found = await findAction(resolved, actionName, language);
  if (!found) return null;
  const { instance, definition } = resolved;
  const shaped = withActionOverrides(found.action, instance, language);
  const toolDef = toolDefinitionOf(resolved, found.action, found.fingerprint);
  const platform = options.platform || configCache.getPlatform() || {};
  const policy = resolveToolApproval(toolDef, null, platform, { installation: instance });
  const override = actionOverrideOf(instance, actionName);
  const listed = (definition.actions || []).find(a => a.name === actionName);
  const adapter = getProtocolAdapter(definition.protocol.type);
  const methodHint = sideEffectOfMethod(found.action.httpMethod);
  const instructions = integrationInstructionsOf(
    definition,
    instance,
    language,
    adapter?.serverInstructions?.(instance) || null
  );

  let usage = null;
  try {
    usage = await readActionUsage(instance.id, actionName);
  } catch (error) {
    logger.warn('Could not read the usage of an integration action', {
      component: COMPONENT,
      instanceId: instance.id,
      action: actionName,
      error: error.message
    });
  }

  return {
    installation: {
      id: instance.id,
      label: resolved.label,
      definition: definition.id,
      protocol: definition.protocol.type,
      enabled: instance.enabled !== false,
      authMode: instance.auth?.mode || 'none'
    },
    action: {
      name: shaped.name,
      title: shaped.title || shaped.name,
      toolId: toolDef.id,
      operationId: shaped.operationId || null,
      httpMethod: found.action.httpMethod || null,
      /** The tool description exactly as the model reads it. */
      description: shaped.description || shaped.title || shaped.name,
      /** The parameter schema exactly as sent to the model. */
      parameters: shaped.parameters || { type: 'object', properties: {} },
      guidance: shaped.guidance || '',
      examples: shaped.examples,
      /** The definition's (or server's) own texts, for "reset to default". */
      defaults: shaped.defaults,
      overridden: shaped.overridden,
      /** The stored override texts (every language), for editing. */
      overrideTexts: {
        description: override.description ?? null,
        guidance: override.guidance ?? null,
        examples: override.examples ?? null
      },
      enabled: found.action.enabled !== false,
      available: found.action.available !== false,
      error: found.action.error || null,
      requirementsMet: found.action.requirementsMet !== false,
      review: actionReviewState(instance, actionName, found.fingerprint)
    },
    effect: {
      sideEffect: policy.sideEffect,
      sideEffectSource: policy.sideEffectSource,
      /** What the vendor declared (definition, MCP annotation, A2A: unknown). */
      declaredSideEffect:
        toolDef._mcp || toolDef._a2a ? found.action.sideEffect : listed?.sideEffect || 'unknown',
      /** What the OpenAPI operation's HTTP method suggests, when it has one. */
      methodSideEffect: methodHint,
      dataFlow: policy.dataFlow,
      dataFlowSource: dataFlowSourceOf(toolDef, instance),
      override: {
        sideEffect: override.sideEffect || null,
        dataFlow: override.dataFlow || null
      }
    },
    approval: {
      /** The mode a chat resolves for this action without an app override. */
      mode: policy.approval,
      source: policy.approvalSource,
      actionMode: instance.approval?.actions?.[actionName] || null,
      installationDefault: instance.approval?.default || null,
      newOrChanged: instance.approval ? instance.approval.newOrChanged || 'always' : null
    },
    instructions: {
      text: instructions.text,
      source: instructions.source,
      own: instance.instructions ?? null
    },
    bindings: await bindingsOf(resolved, shaped, toolDef, language),
    usage,
    test: {
      connections: testConnectionsOf(instance),
      needsConfirmation: testNeedsConfirmation(policy),
      runnable: !found.action.error && found.action.requirementsMet !== false
    }
  };
}
