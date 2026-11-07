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
 *   actions of the integrations a group is granted (`permissions.integrations`).
 *   A tool grant never granted an installation, so no entry becomes an
 *   integration grant (that would widen what the group may use); every dropped
 *   entry is reported, with the installation it named, for the admin to decide.
 * - **Loop bodies** kept inline under a node's `config.body` are rewritten like
 *   any node.
 * - **Tool files** (`contents/tools/*.json`): nothing selects them any more;
 *   each one found is reported and left in place. A `read_url.json` with
 *   `enabled: false` (V204 writes one to keep the page reader off) sets
 *   `platform.webSearch.pageReader: false`, which keeps the reader off.
 *
 * Self-contained: the reference table lives in `support/toolReferences.js`, a
 * frozen snapshot of the built-in definitions that both V229 and V230 share.
 */

export const version = '230';
export const description = 'tools_to_integrations_everywhere';

import { resolveReference } from './support/toolReferences.js';

export { resolveReference };

const INTEGRATIONS_FILE = 'config/integrations.json';
const GROUPS_FILE = 'config/groups.json';
const PLATFORM_FILE = 'config/platform.json';
const READER_TOOL_FILE = 'tools/read_url.json';

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

/** The node configs and task templates of a list of nodes, loop bodies kept inline included. */
function* holdersOfNodes(nodes) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!plainObject(node?.config)) continue;
    yield node.config;
    if (plainObject(node.config.taskTemplate)) yield node.config.taskTemplate;
    // A loop keeps its body inline under `config.body` (`LoopNodeExecutor`).
    yield* holdersOfNodes(node.config.body);
  }
}

/** Every node config and task template of a workflow or profile document. */
function* holdersOf(doc) {
  if (!plainObject(doc)) return;
  yield doc; // an agent profile carries its own list
  const definitions = [doc, doc?.workflow?.definition].filter(plainObject);
  for (const definition of definitions) yield* holdersOfNodes(definition.nodes);
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
 * Drop `permissions.tools` of every group. A tool grant was never an
 * integration grant (the gateways offered tool files and platform tools, and
 * an installation's tools only through `permissions.integrations`), so no
 * entry is turned into one: that would widen what the group may use. Entries
 * naming an installation's tools are reported with the installation, and the
 * admin decides whether the group should hold it in `integrations`.
 * @returns {{ changed: boolean, dropped: Array<{group: string, ref: string, installation?: string, all?: boolean}> }}
 */
export function migrateGroups(groupsConfig, installed) {
  const dropped = [];
  let changed = false;
  for (const [groupId, group] of Object.entries(groupsConfig?.groups || {})) {
    const permissions = group?.permissions;
    if (!plainObject(permissions) || !Object.hasOwn(permissions, 'tools')) continue;
    const list = Array.isArray(permissions.tools) ? permissions.tools : [];
    delete permissions.tools;
    changed = true;
    for (const ref of list) {
      if (typeof ref !== 'string') continue;
      if (ref === '*') {
        dropped.push({ group: groupId, ref, all: true });
        continue;
      }
      if (SYSTEM_TOOLS.has(ref)) continue; // platform tools are not integrations
      const hit = resolveReference(ref, installed);
      dropped.push(
        hit ? { group: groupId, ref, installation: hit.instanceId } : { group: groupId, ref }
      );
    }
  }
  return { changed, dropped };
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
    const { changed, dropped } = migrateGroups(groups, installed);
    if (changed) {
      await ctx.writeJson(GROUPS_FILE, groups);
      ctx.log('groups: permissions.tools removed (the gateways offer the granted integrations)');
      for (const { group, ref, installation, all } of dropped) {
        ctx.warn(
          all
            ? `group "${group}": the direct grant of every tool ("*") was removed. It never granted an integration; the MCP gateway offers the integrations a group is granted (permissions.integrations), so check that list.`
            : installation
              ? `group "${group}": the direct tool grant "${ref}" was removed. It did not grant the installation "${installation}" and is not turned into a grant; add "${installation}" to the group's integrations (Admin → Groups) if the group should use it.`
              : `group "${group}": the direct tool grant "${ref}" belongs to no installed integration and was removed.`
        );
      }
    }
  }

  // The page reader of web search was switched off by a `read_url` tool file
  // with `enabled: false` (V204 writes one). Tool files are not read any more:
  // keep the reader off through the platform setting that replaces it.
  if (await ctx.fileExists(READER_TOOL_FILE)) {
    let reader = null;
    try {
      reader = await ctx.readJson(READER_TOOL_FILE);
    } catch {
      /* an unreadable file is reported with the other tool files below */
    }
    if (reader?.enabled === false) {
      const platform = (await ctx.fileExists(PLATFORM_FILE))
        ? await ctx.readJson(PLATFORM_FILE)
        : {};
      const next = plainObject(platform) ? platform : {};
      next.webSearch = {
        ...(plainObject(next.webSearch) ? next.webSearch : {}),
        pageReader: false
      };
      await ctx.writeJson(PLATFORM_FILE, next);
      ctx.log(`${READER_TOOL_FILE} was disabled: platform.webSearch.pageReader set to false`);
    }
  }

  for (const file of await ctx.listFiles('tools', '*.json')) {
    ctx.warn(
      `tools/${file}: no app, node or gateway uses tool files any more; custom tools are custom integrations (Admin → Integrations → Add manually). The file is left in place.`
    );
  }
}
