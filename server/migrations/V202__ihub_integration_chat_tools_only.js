// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V202 — the iHub integration keeps only the tools users call in chats
 *
 * The always-installed integration `ihub` (`com.intrafind/ihub`) owns
 * `ask_user` and the scheduled-task tools only. The tools of other iHub
 * features stay with those features (Unified Integrations concept §6.9):
 *
 * - the project knowledge tools (`knowledge_search`, `knowledge_read`,
 *   `knowledge_list`) come with every request that reaches a project, while
 *   the projects feature is on; nothing switches them off;
 * - the agent workspace tools (`write_artifact`, `read_memory`,
 *   `write_memory`, `read_inbox`, `write_inbox`, `create_task`, `list_tasks`,
 *   `mark_task_done`) and the evidence tools (`evidence_*`) are platform tools
 *   of workflows and agents, offered to whatever names them in `tools`. As
 *   before V199, a tool file of their id in `contents/tools/` takes the place
 *   of the shipped definition, and one with `enabled: false` switches the
 *   tool off.
 *
 * What it does:
 *
 * 1. `contents/tools/`: the shipped tool files V199 retired are removed again
 *    where they are back as shipped (initial setup seeded them into
 *    `contents/tools/` on every start until this release). A copy of an iHub
 *    file that is `enabled: false` becomes an entry of the installation's
 *    `actions.disabled`, as in V199; a copy of a workflow or agent tool file
 *    that is `enabled: false` is kept, because it is that tool's off switch.
 *    A shipped `knowledge.json` is removed even when switched off (with a
 *    warning: the knowledge tools cannot be switched off any more); an edited
 *    one is left in place with a warning: it is no longer read.
 * 2. `config/integrations.json`: the moved action names leave the `ihub`
 *    installation's per-action lists (`actions.enabled`, `actions.disabled`,
 *    `actions.overrides`). A workflow or agent tool the installation had
 *    switched off stays off: its shipped tool file is written to
 *    `contents/tools/` with `enabled: false` (all functions of `evidence`
 *    together, since a tool file switches the whole file). A switched-off
 *    knowledge action, or a single evidence function, cannot be carried over
 *    and is named in a warning.
 *
 * A missing file or installation is a no-op; a second run changes nothing.
 */

export const version = '202';
export const description = 'ihub_integration_chat_tools_only';

const INTEGRATIONS_FILE = 'config/integrations.json';
export const INSTANCE_ID = 'ihub';
const DEFINITION = 'com.intrafind/ihub';
const DEFINITION_VERSION = '1.0.0';
const KNOWLEDGE_FILE_ID = 'knowledge';

/** The project knowledge tools, which belong to projects from now on. */
export const KNOWLEDGE_ACTIONS = Object.freeze([
  'knowledge_search',
  'knowledge_read',
  'knowledge_list'
]);

/**
 * The tool files of the workflow and agent tools and the action names each
 * stands for (a file with `functions` holds several).
 */
export const WORKFLOW_TOOL_FILES = Object.freeze({
  create_task: ['create_task'],
  evidence: ['evidence_collect', 'evidence_validateQuotesFastPath', 'evidence_composeReport'],
  list_tasks: ['list_tasks'],
  mark_task_done: ['mark_task_done'],
  read_inbox: ['read_inbox'],
  read_memory: ['read_memory'],
  write_artifact: ['write_artifact'],
  write_inbox: ['write_inbox'],
  write_memory: ['write_memory']
});

/** The agent workspace and evidence tools, which belong to workflows and agents. */
export const WORKFLOW_ACTIONS = Object.freeze(Object.values(WORKFLOW_TOOL_FILES).flat());

/** Every action name the installation no longer has. */
export const MOVED_ACTIONS = Object.freeze([...KNOWLEDGE_ACTIONS, ...WORKFLOW_ACTIONS]);

/** The tool files of the actions the installation keeps (one action per file). */
export const IHUB_TOOL_FILES = Object.freeze([
  'ask_user',
  'delete_scheduled_task',
  'get_task_run',
  'list_scheduled_tasks',
  'list_task_runs',
  'run_scheduled_task_now',
  'schedule_task',
  'update_scheduled_task'
]);

// Snapshot of V199's SHIPPED_HASHES (2026-10-31): SHA-256 of each shipped
// tool file as V199 retired it — the parsed file without `enabled`, keys
// sorted in code-unit order, serialized with JSON.stringify. Do NOT replace
// with an import: migrations must be self-contained.
export const SHIPPED_HASHES = Object.freeze({
  ask_user: 'd150790169219be204c2cefe11826306a1a2cfdea6e3b749059d71256641dcb5',
  create_task: 'c5e4a642a1c7771b03327d85cc3ffd0e02f483d8c25e2f9cafd9af0214c02a09',
  delete_scheduled_task: '1ca547c8b5fe56a07236e43e107c2c3e80be6096687d33dda95e0b5f11590ac5',
  evidence: '0c66b572ec4c20084df3f73581b844d73f32f885daad716771d3c929fdbd9d0d',
  get_task_run: '21af56f431c28ea690a1ee81581a8415e4735144b3d4db6d0058de9378a5eaa3',
  knowledge: 'c196aa70f38455ced9d29704ad6fb984749043767667dbdbe2b86917177402dd',
  list_scheduled_tasks: 'f43d48dded9fe2194c4139f405cc6f9958a33a7767f22e8521f3ae8a4e949494',
  list_task_runs: '6b8682b367268296c0f33711c58ffeac216213f741d75015ad9a7cd65a802632',
  list_tasks: '147518d67857d43b3aa6fb2c65d4d864fcb07fe3601189008f22db584d1b327f',
  mark_task_done: '4bec638cc2b4d74ebd65db58700d61211213dc57aa0c2be2c67dd53dc2c256a6',
  read_inbox: 'c7aacab20614b548ab96238ed12978d10a33f8fc1c1f49b4e80dc7522c91794f',
  read_memory: '698491c45e65ece33580e66c90405ec71f37ac15259da37d32bdc8e6f3c3abfa',
  run_scheduled_task_now: 'ff30515f5e79cf6ab26ca2be8522c7903e9dd64a9aa9fa7cb53a2b9e53df1e82',
  schedule_task: '2d2ce8250983527b12465c50a62bf1b9c15395fd38ef9f2c16ae950ed2ee1a68',
  update_scheduled_task: '24632bcfd5e076ebac1f4cd08442a563787b1166851f5c799c24aa27e42d9561',
  write_artifact: '23329214d7746abf53d0e1866422d8e4ba77a1fccef10b66f00a6061c1817376',
  write_inbox: 'ad2ecc0f160933d6d515e652a9339d8286c1776ca6f1d17911898e72efd5886f',
  write_memory: '5ada1d90d1e8eea1d49dcedb4bad904eb9268245eadb519c62cbfaeb144ed467'
});

const MOVED = new Set(MOVED_ACTIONS);
const toolFile = id => `tools/${id}.json`;

// Snapshot of V199's byCodeUnit / sortKeys / contentHash (2026-10-31).
function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(byCodeUnit)
        .map(key => [key, sortKeys(value[key])])
    );
  }
  return value;
}

/**
 * The hash of a tool file's content the way {@link SHIPPED_HASHES} was taken.
 * @param {object} tool - parsed tool file
 * @param {(text: string) => string} sha256 - hex digest
 * @returns {string}
 */
export function contentHash(tool, sha256) {
  const rest = { ...tool };
  delete rest.enabled;
  return sha256(JSON.stringify(sortKeys(rest)));
}

export async function precondition(ctx) {
  if (await ctx.fileExists(INTEGRATIONS_FILE)) return true;
  for (const id of Object.keys(SHIPPED_HASHES)) {
    if (await ctx.fileExists(toolFile(id))) return true;
  }
  return false;
}

/**
 * The moved actions an installation's action policy kept off: listed in
 * `disabled`, or left out of an explicit `enabled` list (one without `*`).
 * @param {object} [actions] - the installation's `actions`
 * @returns {string[]}
 */
export function switchedOffMovedActions(actions = {}) {
  const enabled = Array.isArray(actions?.enabled) ? actions.enabled : ['*'];
  const disabled = new Set(Array.isArray(actions?.disabled) ? actions.disabled : []);
  const allEnabled = enabled.includes('*');
  return MOVED_ACTIONS.filter(
    name => disabled.has(name) || (!allEnabled && !enabled.includes(name))
  );
}

/**
 * Remove the moved action names from one per-action list, in place.
 * @param {object} actions - the installation's `actions`
 * @param {'enabled'|'disabled'} list - which list
 * @returns {string[]} the names removed, labelled with the list (`disabled: write_artifact`)
 */
function removeMovedFromList(actions, list) {
  if (!Array.isArray(actions[list])) return [];
  const removed = actions[list].filter(name => MOVED.has(name)).map(name => `${list}: ${name}`);
  actions[list] = actions[list].filter(name => !MOVED.has(name));
  return removed;
}

/**
 * Remove the moved action names from `actions.overrides`, in place.
 * @param {object} [overrides] - the installation's `actions.overrides`
 * @returns {string[]} the names removed, labelled (`overrides: write_memory`)
 */
function removeMovedOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object') return [];
  const names = Object.keys(overrides).filter(name => MOVED.has(name));
  for (const name of names) delete overrides[name];
  return names.map(name => `overrides: ${name}`);
}

/**
 * Remove the moved action names from an installation's action policy, in place.
 * @param {object} instance - the `ihub` installation
 * @returns {string[]} the names removed, list by list (`disabled: write_artifact`, …)
 */
export function removeMovedActions(instance) {
  const actions = instance.actions;
  if (!actions || typeof actions !== 'object') return [];
  return [
    ...removeMovedFromList(actions, 'enabled'),
    ...removeMovedFromList(actions, 'disabled'),
    ...removeMovedOverrides(actions.overrides)
  ];
}

/**
 * The retired tool files present in `contents/tools/`, read in parallel (the
 * reads are independent; the result keeps the order of {@link SHIPPED_HASHES}).
 * @param {object} ctx - migration context
 * @returns {Promise<Array<{id: string, rel: string, tool: object}>>}
 */
async function readRetiredToolFiles(ctx) {
  const found = await Promise.all(
    Object.keys(SHIPPED_HASHES).map(async id => {
      const rel = toolFile(id);
      if (!(await ctx.fileExists(rel))) return null;
      return { id, rel, tool: await ctx.readJson(rel) };
    })
  );
  return found.filter(Boolean);
}

/**
 * What step 1 does with a retired tool file found in `contents/tools/`.
 * @param {string} id - the file's id
 * @param {object} tool - the parsed file
 * @param {(text: string) => string} sha256 - hex digest
 * @returns {'remove'|'keep'|'stale-knowledge'} `remove` for a copy as shipped;
 *   `stale-knowledge` for an edited `knowledge.json`, which is no longer read;
 *   `keep` for any other edited file (it keeps serving its tool, as V199 left
 *   it) and for a switched-off workflow or agent tool file (that tool's off switch)
 */
function retiredToolFileFate(id, tool, sha256) {
  const asShipped = Boolean(tool) && contentHash(tool, sha256) === SHIPPED_HASHES[id];
  if (!asShipped) return id === KNOWLEDGE_FILE_ID ? 'stale-knowledge' : 'keep';
  if (WORKFLOW_TOOL_FILES[id] && tool.enabled === false) return 'keep';
  return 'remove';
}

/**
 * Step 1: remove the retired tool files that are back in `contents/tools/`
 * as shipped.
 * @param {object} ctx - migration context
 * @param {(text: string) => string} sha256 - hex digest
 * @returns {Promise<{disabledIhubActions: string[], knowledgeOff: boolean}>}
 *   the iHub actions a removed copy had switched off, and whether a removed
 *   `knowledge.json` had been switched off
 */
async function removeShippedCopies(ctx, sha256) {
  const disabledIhubActions = [];
  let knowledgeOff = false;
  const files = await readRetiredToolFiles(ctx);
  // Sequential on purpose: a migration deletes one file at a time, so its log follows the files' order.
  for (const { id, rel, tool } of files) {
    const fate = retiredToolFileFate(id, tool, sha256);
    if (fate === 'stale-knowledge') {
      ctx.warn(
        `${rel} is no longer read: the knowledge tools are defined by projects and offered whenever a request reaches a project. Delete the file; its changes do not apply any more.`
      );
    }
    if (fate !== 'remove') continue;
    const off = tool.enabled === false;
    if (off && IHUB_TOOL_FILES.includes(id)) disabledIhubActions.push(id);
    if (off && id === KNOWLEDGE_FILE_ID) knowledgeOff = true;
    await ctx.deleteFile(rel);
    ctx.log(`${rel} removed: it was the shipped file, which iHub reads in place`);
  }
  return { disabledIhubActions, knowledgeOff };
}

/**
 * The workflow and agent tool files whose actions the installation had all
 * switched off, each with what `contents/tools/` and the shipped defaults
 * hold for it, read in parallel (the reads are independent; the result keeps
 * the order of {@link WORKFLOW_TOOL_FILES}).
 * @param {object} ctx - migration context
 * @param {Set<string>} switchedOff - moved action names the installation kept off
 * @returns {Promise<Array<{rel: string, actions: string[], kind: 'present'|'shipped'|'unreadable', shipped?: object, error?: any}>>}
 *   `present`: `contents/tools/` has a file of that id; `shipped`: the shipped
 *   file to write; `unreadable`: the shipped file could not be read
 */
async function readSwitchedOffWorkflowTools(ctx, switchedOff) {
  const offFiles = Object.entries(WORKFLOW_TOOL_FILES).filter(([, actions]) =>
    actions.every(name => switchedOff.has(name))
  );
  return Promise.all(
    offFiles.map(async ([id, actions]) => {
      const rel = toolFile(id);
      if (await ctx.fileExists(rel)) return { rel, actions, kind: 'present' };
      try {
        return { rel, actions, kind: 'shipped', shipped: await ctx.readDefaultJson(rel) };
      } catch (error) {
        return { rel, actions, kind: 'unreadable', error };
      }
    })
  );
}

/**
 * Write the shipped tool file of every workflow or agent tool whose actions
 * the installation had all switched off, with `enabled: false`.
 * @param {object} ctx - migration context
 * @param {Set<string>} switchedOff - moved action names the installation kept off
 * @returns {Promise<Set<string>>} the switched-off action names now carried by a tool file
 */
async function keepWorkflowToolsOff(ctx, switchedOff) {
  const carried = new Set();
  const files = await readSwitchedOffWorkflowTools(ctx, switchedOff);
  // Sequential on purpose: a migration writes one file at a time, so its log follows the files' order.
  for (const { rel, actions, kind, shipped, error } of files) {
    if (kind === 'unreadable') {
      ctx.warn(`${rel} could not be read from the shipped defaults: ${error.message}`);
      continue;
    }
    // A file of that id (kind `present`) decides about the tool, as it did before and since V199.
    if (kind === 'shipped') {
      await ctx.writeJson(rel, { ...shipped, enabled: false });
      ctx.log(
        `${rel} written with enabled: false: ${actions.join(', ')} stayed switched off (switch it on in Admin → Tools or delete the file)`
      );
    }
    for (const name of actions) carried.add(name);
  }
  return carried;
}

/**
 * The SHA-256 hex digest from node:crypto, loaded when the migration runs.
 * @returns {Promise<(text: string) => string>}
 */
async function nodeSha256() {
  const { createHash } = await import('node:crypto');
  return text => createHash('sha256').update(text).digest('hex');
}

/**
 * `config/integrations.json`, with an `installed` list.
 * @param {object} ctx - migration context
 * @param {boolean} hasConfig - whether the file exists (an empty config when not)
 * @returns {Promise<object>}
 */
async function readIntegrations(ctx, hasConfig) {
  const config = (hasConfig ? await ctx.readJson(INTEGRATIONS_FILE) : null) || {};
  if (!Array.isArray(config.installed)) config.installed = [];
  return config;
}

/**
 * Add the `ihub` installation to `config` as V199 creates it: enabled, every
 * action on unless switched off afterwards.
 * @param {object} ctx - migration context
 * @param {object} config - `config/integrations.json`, changed in place
 * @returns {object} the new installation
 */
function createInstance(ctx, config) {
  const now = new Date().toISOString();
  const instance = {
    id: INSTANCE_ID,
    definition: DEFINITION,
    definitionVersion: DEFINITION_VERSION,
    enabled: true,
    values: {},
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    allowedGroups: [],
    installedAt: now,
    updatedAt: now
  };
  config.installed.push(instance);
  if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };
  ctx.log(`Installed integration "${INSTANCE_ID}" created (${DEFINITION})`);
  return instance;
}

/**
 * Add iHub actions to an installation's `actions.disabled`, in place.
 * @param {object} instance - the `ihub` installation
 * @param {string[]} names - the actions to switch off
 */
function disableIhubActions(instance, names) {
  if (!instance.actions || typeof instance.actions !== 'object') {
    instance.actions = { enabled: ['*'], disabled: [], overrides: {} };
  }
  const disabled = Array.isArray(instance.actions.disabled) ? instance.actions.disabled : [];
  instance.actions.disabled = [...new Set([...disabled, ...names])];
}

/**
 * Step 2 on the installation, in place: drop the moved action names and
 * switch off the iHub actions whose removed tool files were switched off.
 * @param {object} ctx - migration context
 * @param {object} instance - the `ihub` installation
 * @param {string[]} disabledIhubActions - from {@link removeShippedCopies}
 * @returns {boolean} whether the installation changed
 */
function moveInstanceActions(ctx, instance, disabledIhubActions) {
  const removed = removeMovedActions(instance);
  if (removed.length) {
    ctx.log(
      `Installation "${INSTANCE_ID}": removed the knowledge, agent and evidence tools from its actions (${removed.join(', ')})`
    );
  }
  if (disabledIhubActions.length) {
    disableIhubActions(instance, disabledIhubActions);
    ctx.log(
      `Installation "${INSTANCE_ID}": ${disabledIhubActions.join(', ')} switched off, as their tool files were`
    );
  }
  return removed.length > 0 || disabledIhubActions.length > 0;
}

/**
 * @param {object} ctx - migration context
 * @param {{ sha256?: (text: string) => string }} [deps] - hashing (node:crypto when absent)
 */
export async function up(ctx, deps = {}) {
  const sha256 = deps.sha256 || (await nodeSha256());
  const { disabledIhubActions, knowledgeOff } = await removeShippedCopies(ctx, sha256);

  const hasConfig = await ctx.fileExists(INTEGRATIONS_FILE);
  if (!hasConfig && disabledIhubActions.length === 0) {
    warnSwitchedOff(ctx, knowledgeOff);
    return;
  }
  const config = await readIntegrations(ctx, hasConfig);
  const existing = config.installed.find(inst => inst?.id === INSTANCE_ID);
  if (!existing && disabledIhubActions.length === 0) {
    ctx.log(`No installation "${INSTANCE_ID}" in ${INTEGRATIONS_FILE}; nothing to change`);
    warnSwitchedOff(ctx, knowledgeOff);
    return;
  }

  const instance = existing || createInstance(ctx, config);
  const switchedOff = new Set(switchedOffMovedActions(instance.actions));
  const updated = moveInstanceActions(ctx, instance, disabledIhubActions);
  if (!existing || updated) {
    instance.updatedAt = new Date().toISOString();
    await ctx.writeJson(INTEGRATIONS_FILE, config);
  } else {
    ctx.log(`Installation "${INSTANCE_ID}" names none of the moved tools; nothing to change`);
  }

  const carried = await keepWorkflowToolsOff(ctx, switchedOff);
  warnSwitchedOff(ctx, knowledgeOff, switchedOff, carried);
}

/**
 * Warn about the switches that do not survive the move: knowledge actions
 * that were off (they cannot be switched off any more), and workflow or agent
 * actions that were off and no tool file keeps off.
 * @param {object} ctx - migration context
 * @param {boolean} knowledgeFileOff - a removed `knowledge.json` had been switched off
 * @param {Set<string>} [switchedOff] - moved action names the installation kept off
 * @param {Set<string>} [carried] - the ones a tool file now keeps off
 */
function warnSwitchedOff(ctx, knowledgeFileOff, switchedOff = new Set(), carried = new Set()) {
  const knowledgeOff = KNOWLEDGE_ACTIONS.filter(name => knowledgeFileOff || switchedOff.has(name));
  const workflowOn = WORKFLOW_ACTIONS.filter(name => switchedOff.has(name) && !carried.has(name));
  const parts = [];
  if (knowledgeOff.length) {
    parts.push(
      `${knowledgeOff.join(', ')} now come with every request that reaches a project and cannot be switched off`
    );
  }
  if (workflowOn.length) {
    parts.push(
      `${workflowOn.join(', ')} are now offered to the workflows, agents and apps that name them in "tools" (a tool file switches all evidence tools at once); remove them there to stop using them`
    );
  }
  if (parts.length) {
    ctx.warn(
      `Tools switched off that are no longer actions of "${INSTANCE_ID}": ${parts.join('; ')}.`
    );
  }
}
