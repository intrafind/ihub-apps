// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V230 — workflow nodes, agent profiles and group grants stop
 * listing tools; every tool is an action of an integration
 *
 * V229 took the `tools` list out of apps. This migration does the same for
 * the rest of iHub (#3275):
 *
 * - **Workflow nodes and agent profiles** (`contents/workflows/*.json`,
 *   `contents/agents/profiles/*.json`, including a profile's embedded
 *   workflow and a planner's `taskTemplate`): `config.tools` becomes
 *   - `integrations` — bindings, as for an app: iFinder, Jira, iHub's own
 *     tools, an engine's search tool (`braveSearch` → the engine's binding with
 *     its `search` action), `<installation>__<action>` and installation ids;
 *   - `webSearch: true` — the generic `webSearch` marker;
 *   - `systemTools` — the platform tools of workflows and agents
 *     (`write_artifact`, `read_memory`, `evidence`, `read_url`, …), which are
 *     plain tools and not integrations.
 *   A reference that is none of these is reported with the file and removed.
 * - **Groups** (`config/groups.json`): `permissions.tools` (direct tool access
 *   over the MCP and A2A gateways) is removed. The gateways now offer the
 *   actions of the integrations a group is granted (`permissions.integrations`);
 *   an entry that names an installation's tools adds that installation to the
 *   group's `integrations` (unless the group already holds `*`), so what the
 *   group could reach stays reachable. Entries that map to no installation are
 *   reported.
 * - **Tool files** (`contents/tools/*.json`): nothing selects them any more;
 *   each one found is reported and left in place.
 *
 * Self-contained: the tables below are snapshots of the built-in definitions
 * as of this migration.
 */

export const version = '230';
export const description = 'tools_to_integrations_everywhere';

const INTEGRATIONS_FILE = 'config/integrations.json';
const GROUPS_FILE = 'config/groups.json';

/** The platform tools (and base ids) a node or profile may name in `systemTools`. */
const SYSTEM_TOOLS = new Set([
  'write_artifact',
  'read_memory',
  'write_memory',
  'read_inbox',
  'write_inbox',
  'create_task',
  'list_tasks',
  'mark_task_done',
  'set_plan',
  'update_task',
  'evidence',
  'evidence_collect',
  'evidence_validateQuotesFastPath',
  'evidence_composeReport',
  'read_url'
]);

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
const IFINDER_ACTIONS = [
  'search',
  'getContent',
  'getMetadata',
  'discover',
  'getFields',
  'getFacetValues',
  'listProfiles'
];
const JIRA_ACTIONS = [
  'searchTickets',
  'getTicket',
  'addComment',
  'getTransitions',
  'transitionTicket',
  'getAttachment'
];
const ENGINE_TOOL_IDS = {
  'com.intrafind/brave-search': 'braveSearch',
  'com.intrafind/staan-search': 'staanSearch',
  'com.intrafind/qwant-search': 'qwantSearch'
};

export async function precondition(ctx) {
  for (const dir of ['workflows', 'agents/profiles', 'tools']) {
    if ((await ctx.listFiles(dir, '*.json')).length > 0) return true;
  }
  return await ctx.fileExists(GROUPS_FILE);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The installation and actions a tool reference points at, or null.
 * @param {string} ref
 * @param {Array<{id: string, definition?: string}>} installed
 * @returns {{ instanceId: string, actions: string[]|'all' }|null}
 */
export function resolveReference(ref, installed) {
  const byDefinition = definition => installed.find(inst => inst?.definition === definition);
  const ihub = byDefinition('com.intrafind/ihub');
  if (ihub && IHUB_ACTIONS.includes(ref)) return { instanceId: ihub.id, actions: [ref] };
  const ifinder = byDefinition('com.intrafind/ifinder');
  if (ifinder) {
    if (ref === 'iFinder') return { instanceId: ifinder.id, actions: 'all' };
    const name = ref.startsWith('iFinder_') ? ref.slice('iFinder_'.length) : null;
    if (name && IFINDER_ACTIONS.includes(name)) return { instanceId: ifinder.id, actions: [name] };
  }
  const jira = byDefinition('com.intrafind/jira');
  if (jira) {
    if (ref === 'jira') return { instanceId: jira.id, actions: 'all' };
    const name = ref.startsWith('jira_') ? ref.slice('jira_'.length) : null;
    if (name && JIRA_ACTIONS.includes(name)) return { instanceId: jira.id, actions: [name] };
  }
  for (const [definition, toolId] of Object.entries(ENGINE_TOOL_IDS)) {
    const engine = byDefinition(definition);
    if (engine && ref === toolId) return { instanceId: engine.id, actions: ['search'] };
  }
  const whole = installed.find(inst => inst?.id === ref);
  if (whole) return { instanceId: whole.id, actions: 'all' };
  if (ref.startsWith('a2a__')) {
    const agent = installed.find(inst => ref === `a2a__${inst?.id}`);
    if (agent) return { instanceId: agent.id, actions: 'all' };
    const skill = installed.find(inst => ref.startsWith(`a2a__${inst?.id}__`));
    if (skill) return { instanceId: skill.id, actions: [ref.slice(`a2a__${skill.id}__`.length)] };
  }
  const owner = [...installed]
    .filter(inst => typeof inst?.id === 'string' && ref.startsWith(`${inst.id}__`))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (owner) return { instanceId: owner.id, actions: [ref.slice(`${owner.id}__`.length)] };
  return null;
}

/**
 * Split a list of tool references into bindings, platform tools and the web
 * search switch.
 *
 * @param {string[]} refs
 * @param {Array<{id: string, definition?: string}>} installed
 * @param {Object} [existing] - bindings the config already has
 * @returns {{ integrations: Object, systemTools: string[], webSearch: boolean, unmapped: string[] }}
 */
export function splitReferences(refs, installed, existing = {}) {
  const picks = new Map();
  const systemTools = [];
  const unmapped = [];
  let webSearch = false;
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref) continue;
    if (ref === 'webSearch') {
      webSearch = true;
      continue;
    }
    if (SYSTEM_TOOLS.has(ref)) {
      if (!systemTools.includes(ref)) systemTools.push(ref);
      continue;
    }
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
  const integrations = plainObject(existing) ? { ...existing } : {};
  for (const [instanceId, pick] of picks) {
    const binding = plainObject(integrations[instanceId]) ? { ...integrations[instanceId] } : {};
    const had = Object.hasOwn(integrations, instanceId);
    if (pick === 'all') delete binding.actions;
    else if (!had || Array.isArray(binding.actions)) {
      binding.actions = [...new Set([...(binding.actions || []), ...pick])];
    }
    integrations[instanceId] = binding;
  }
  return { integrations, systemTools, webSearch, unmapped };
}

/**
 * Rewrite one config object (a node's `config`, a task template or a profile)
 * that has a `tools` list. Returns whether it changed; collects what could
 * not be mapped.
 *
 * @param {Object} holder
 * @param {Array} installed
 * @param {string[]} unmapped - receives the references that map nowhere
 * @returns {boolean}
 */
export function rewriteHolder(holder, installed, unmapped) {
  if (!plainObject(holder) || !Object.hasOwn(holder, 'tools')) return false;
  const refs = Array.isArray(holder.tools) ? holder.tools : [];
  const split = splitReferences(refs, installed, holder.integrations);
  delete holder.tools;
  if (Object.keys(split.integrations).length > 0) holder.integrations = split.integrations;
  if (split.systemTools.length > 0) {
    holder.systemTools = [...new Set([...(holder.systemTools || []), ...split.systemTools])];
  }
  if (split.webSearch) holder.webSearch = true;
  unmapped.push(...split.unmapped);
  return true;
}

/** Every node config and task template of a workflow or profile document. */
function* holdersOf(doc) {
  if (!plainObject(doc)) return;
  yield doc; // an agent profile carries its own list
  const definitions = [doc, doc?.workflow?.definition].filter(plainObject);
  for (const definition of definitions) {
    for (const node of Array.isArray(definition.nodes) ? definition.nodes : []) {
      if (!plainObject(node?.config)) continue;
      yield node.config;
      if (plainObject(node.config.taskTemplate)) yield node.config.taskTemplate;
    }
  }
}

/**
 * Rewrite a workflow or agent profile document.
 * @returns {{ changed: boolean, unmapped: string[] }}
 */
export function migrateDocument(doc, installed) {
  const unmapped = [];
  let changed = false;
  for (const holder of holdersOf(doc)) {
    if (rewriteHolder(holder, installed, unmapped)) changed = true;
  }
  return { changed, unmapped };
}

/**
 * Drop `permissions.tools` of every group; entries naming an installation's
 * tools add the installation to the group's `integrations`.
 * @returns {{ changed: boolean, unmapped: Array<{group: string, ref: string}> }}
 */
export function migrateGroups(groupsConfig, installed) {
  const unmapped = [];
  let changed = false;
  for (const [groupId, group] of Object.entries(groupsConfig?.groups || {})) {
    const permissions = group?.permissions;
    if (!plainObject(permissions) || !Object.hasOwn(permissions, 'tools')) continue;
    const list = Array.isArray(permissions.tools) ? permissions.tools : [];
    delete permissions.tools;
    changed = true;
    const integrations = Array.isArray(permissions.integrations) ? permissions.integrations : [];
    for (const ref of list) {
      if (typeof ref !== 'string') continue;
      if (ref === '*') {
        // Every tool over the gateways: the group now needs the integrations
        // themselves. Reported when it does not already hold `*`.
        if (!integrations.includes('*')) unmapped.push({ group: groupId, ref, all: true });
        continue;
      }
      if (SYSTEM_TOOLS.has(ref)) continue; // platform tools are not integrations
      const hit = resolveReference(ref, installed);
      if (!hit) {
        unmapped.push({ group: groupId, ref });
        continue;
      }
      if (!integrations.includes('*') && !integrations.includes(hit.instanceId)) {
        integrations.push(hit.instanceId);
      }
    }
    permissions.integrations = integrations;
  }
  return { changed, unmapped };
}

export async function up(ctx) {
  const config = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  const installed = Array.isArray(config.installed) ? config.installed : [];

  for (const dir of ['workflows', 'agents/profiles']) {
    for (const file of await ctx.listFiles(dir, '*.json')) {
      const rel = `${dir}/${file}`;
      let doc;
      try {
        doc = await ctx.readJson(rel);
      } catch {
        continue;
      }
      const { changed, unmapped } = migrateDocument(doc, installed);
      if (!changed) continue;
      await ctx.writeJson(rel, doc);
      ctx.log(`${rel}: tools → integrations / systemTools / webSearch`);
      if (unmapped.length) {
        ctx.warn(
          `${rel}: the tools ${unmapped.map(ref => `"${ref}"`).join(', ')} belong to no installed integration and were removed; bind the integration that provides them if the workflow still needs them.`
        );
      }
    }
  }

  if (await ctx.fileExists(GROUPS_FILE)) {
    const groups = await ctx.readJson(GROUPS_FILE);
    const { changed, unmapped } = migrateGroups(groups, installed);
    if (changed) {
      await ctx.writeJson(GROUPS_FILE, groups);
      ctx.log('groups: permissions.tools removed (the gateways offer the granted integrations)');
      for (const { group, ref, all } of unmapped) {
        ctx.warn(
          all
            ? `group "${group}": the direct grant of every tool ("*") was removed; the MCP gateway now offers the integrations the group is granted (permissions.integrations), so check that list.`
            : `group "${group}": the direct tool grant "${ref}" belongs to no installed integration and was removed.`
        );
      }
    }
  }

  for (const file of await ctx.listFiles('tools', '*.json')) {
    ctx.warn(
      `tools/${file}: no app, node or gateway uses tool files any more; custom tools are custom integrations (Admin → Integrations → Add manually). The file is left in place.`
    );
  }
}
