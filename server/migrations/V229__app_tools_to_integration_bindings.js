// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V229 — an app's `tools` become bindings under `integrations`
 *
 * Every tool an app offers is an action of an installed integration, so the
 * app's own `tools` list (a second way to grant the same thing, with its own
 * exceptions) is retired (#3275): the app gets tools only through
 * `integrations` (the group's grant of the installation plus the binding's
 * action list). This migration rewrites each `contents/apps/*.json`:
 *
 * - a reference to an action of an installation becomes `actions` of that
 *   installation's binding: iHub's own tools (`ask_user`, the scheduled-task
 *   tools), iFinder (`iFinder_search`, base id `iFinder`), Jira (`jira_*`,
 *   `jira`), a web search engine's search tool (`braveSearch`,
 *   `staanSearch`, `qwantSearch`, `<id>__search`), and the tools of any
 *   installation by its prefix (`<installationId>__<action>`);
 * - a reference to a whole installation (its id — an MCP server, an A2A
 *   agent as `a2a__<agentId>`, a people directory, an LDAP browser, a
 *   catalog integration) binds the installation with every action;
 * - a reference that maps to no installation (a platform tool such as
 *   `read_url` or `write_memory`, a tool file of an old install, an id
 *   nobody installed) is reported with the app's id and removed — the
 *   platform tools belong to workflows and agents, not to apps;
 * - `tools` is removed from the app (also an empty list), and `tools` from
 *   `overriddenFields` of an app that inherits.
 *
 * A binding the app already has keeps its own settings; a binding with an
 * `actions` list gets the migrated actions added, one without a list keeps
 * offering every action. A group that holds the installation (`ihub`,
 * `jira`, …) in `permissions.integrations` is unchanged — whether the
 * groups of an app's users grant the installation stays the admin's choice.
 *
 * Self-contained: the action tables below are snapshots of the built-in
 * definitions as of this migration.
 */

export const version = '229';
export const description = 'app_tools_to_integration_bindings';

const INTEGRATIONS_FILE = 'config/integrations.json';

/** The tools of the `com.intrafind/ihub` installation (tool id = action name). */
const IHUB_ACTIONS = [
  'ask_user',
  'schedule_task',
  'list_scheduled_tasks',
  'update_scheduled_task',
  'delete_scheduled_task',
  'run_scheduled_task_now',
  'list_task_runs',
  'get_task_run'
];

/** `com.intrafind/ifinder`: tool ids are `iFinder_<action>`, the base id is `iFinder`. */
const IFINDER_ACTIONS = [
  'search',
  'getContent',
  'getMetadata',
  'discover',
  'getFields',
  'getFacetValues',
  'listProfiles'
];

/** `com.intrafind/jira`: tool ids are `jira_<action>`, the base id is `jira`. */
const JIRA_ACTIONS = [
  'searchTickets',
  'getTicket',
  'addComment',
  'getTransitions',
  'transitionTicket',
  'getAttachment'
];

/** The search tool id each built-in web search engine kept, by its definition. */
const ENGINE_TOOL_IDS = {
  'com.intrafind/brave-search': 'braveSearch',
  'com.intrafind/staan-search': 'staanSearch',
  'com.intrafind/qwant-search': 'qwantSearch'
};

export async function precondition(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  return files.length > 0;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Where a tool reference points.
 *
 * @param {string} ref - an entry of `app.tools`
 * @param {Array<{id: string, definition?: string}>} installed - the installations
 * @returns {{ instanceId: string, actions: string[]|'all' }|null} null when no installation owns it
 */
export function resolveReference(ref, installed) {
  const byDefinition = definition => installed.find(inst => inst?.definition === definition);

  // iHub's own tools and the built-ins that kept their tool ids
  const ihub = byDefinition('com.intrafind/ihub');
  if (ihub && IHUB_ACTIONS.includes(ref)) return { instanceId: ihub.id, actions: [ref] };

  const ifinder = byDefinition('com.intrafind/ifinder');
  if (ifinder) {
    if (ref === 'iFinder') return { instanceId: ifinder.id, actions: 'all' };
    if (ref.startsWith('iFinder_') && IFINDER_ACTIONS.includes(ref.slice('iFinder_'.length))) {
      return { instanceId: ifinder.id, actions: [ref.slice('iFinder_'.length)] };
    }
  }

  const jira = byDefinition('com.intrafind/jira');
  if (jira) {
    if (ref === 'jira') return { instanceId: jira.id, actions: 'all' };
    if (ref.startsWith('jira_') && JIRA_ACTIONS.includes(ref.slice('jira_'.length))) {
      return { instanceId: jira.id, actions: [ref.slice('jira_'.length)] };
    }
  }

  for (const [definition, toolId] of Object.entries(ENGINE_TOOL_IDS)) {
    const engine = byDefinition(definition);
    if (engine && ref === toolId) return { instanceId: engine.id, actions: ['search'] };
  }

  // The installation itself, or one of its tools by the `<id>__<action>` prefix
  const whole = installed.find(inst => inst?.id === ref);
  if (whole) return { instanceId: whole.id, actions: 'all' };
  if (ref.startsWith('a2a__')) {
    const agent = installed.find(inst => ref === `a2a__${inst?.id}`);
    if (agent) return { instanceId: agent.id, actions: 'all' };
    const skill = installed.find(inst => ref.startsWith(`a2a__${inst?.id}__`));
    if (skill) {
      return { instanceId: skill.id, actions: [ref.slice(`a2a__${skill.id}__`.length)] };
    }
  }
  // The longest id first, so `a-b__x` is not read as installation `a`
  const owner = [...installed]
    .filter(inst => typeof inst?.id === 'string' && ref.startsWith(`${inst.id}__`))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (owner) return { instanceId: owner.id, actions: [ref.slice(`${owner.id}__`.length)] };
  return null;
}

/**
 * Rewrite one app. Returns the app itself when it has no `tools`.
 *
 * @param {object} app
 * @param {Array<{id: string, definition?: string}>} installed
 * @returns {{ app: object, unmapped: string[], bound: string[] }}
 */
export function migrateApp(app, installed) {
  if (!plainObject(app) || !Object.hasOwn(app, 'tools')) return { app, unmapped: [], bound: [] };
  const refs = Array.isArray(app.tools) ? app.tools.filter(ref => typeof ref === 'string') : [];
  const picks = new Map(); // instanceId → Set(action names) | 'all'
  const unmapped = [];
  for (const ref of refs) {
    const hit = resolveReference(ref, installed);
    if (!hit) {
      unmapped.push(ref);
      continue;
    }
    const current = picks.get(hit.instanceId);
    if (current === 'all') continue;
    if (hit.actions === 'all') {
      picks.set(hit.instanceId, 'all');
      continue;
    }
    const names = current || new Set();
    for (const name of hit.actions) names.add(name);
    picks.set(hit.instanceId, names);
  }

  const next = { ...app };
  delete next.tools;
  if (Array.isArray(next.overriddenFields)) {
    next.overriddenFields = next.overriddenFields.filter(field => field !== 'tools');
  }
  if (picks.size > 0) {
    const integrations = plainObject(app.integrations) ? { ...app.integrations } : {};
    for (const [instanceId, pick] of picks) {
      const binding = plainObject(integrations[instanceId]) ? { ...integrations[instanceId] } : {};
      const existed = Object.hasOwn(integrations, instanceId);
      if (pick === 'all') {
        delete binding.actions;
      } else if (!existed || Array.isArray(binding.actions)) {
        binding.actions = [...new Set([...(binding.actions || []), ...pick])];
      }
      integrations[instanceId] = binding;
    }
    next.integrations = integrations;
  }
  return { app: next, unmapped, bound: [...picks.keys()] };
}

export async function up(ctx) {
  const config = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  const installed = Array.isArray(config.installed) ? config.installed : [];

  for (const file of await ctx.listFiles('apps', '*.json')) {
    const rel = `apps/${file}`;
    let app;
    try {
      app = await ctx.readJson(rel);
    } catch {
      continue;
    }
    if (!plainObject(app) || !Object.hasOwn(app, 'tools')) continue;
    const { app: next, unmapped, bound } = migrateApp(app, installed);
    await ctx.writeJson(rel, next);
    if (bound.length) {
      ctx.log(`${rel}: tools → integrations bindings (${bound.join(', ')})`);
    }
    if (unmapped.length) {
      ctx.warn(
        `${rel}: the tools ${unmapped.map(ref => `"${ref}"`).join(', ')} belong to no installed integration and were removed from the app; bind the integration that provides them under Admin → Apps → Integrations if the app still needs them.`
      );
    }
  }
}
