// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V199 — iHub's own tools become the always-installed integration
 * `ihub`
 *
 * The shipped tool files for `ask_user`, the project knowledge tools, the
 * agent tools (artifacts, memory, inboxes, tasks), the evidence tools and the
 * scheduled-task tools are retired: the installation `ihub`
 * (definition `com.intrafind/ihub`) owns them under the same ids, so
 * `app.tools: ["ask_user"]`, group grants and prompts are unchanged.
 *
 * - `config/integrations.json` gets the installation (enabled, every action
 *   on) when it has none;
 * - `contents/tools/<id>.json` is deleted when it is the shipped file as
 *   shipped (compared field by field, `enabled` aside); a file an admin
 *   switched off puts its action(s) into the installation's
 *   `actions.disabled`; a file an admin edited otherwise is left in place
 *   with a warning — it keeps serving the tool in place of the installation's
 *   action until the admin moves the change over and deletes it.
 */

export const version = '199';
export const description = 'ihub_tools_installed_integration';

const INTEGRATIONS_FILE = 'config/integrations.json';
export const INSTANCE_ID = 'ihub';
export const DEFINITION = 'com.intrafind/ihub';
const DEFINITION_VERSION = '1.0.0';

/**
 * SHA-256 of each shipped tool file as of this migration: the parsed file
 * without `enabled`, keys sorted, serialized with JSON.stringify. Byte
 * layout and key order do not matter; any other difference is an admin edit.
 */
export const SHIPPED_HASHES = {
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
};

/** The action names each tool file stands for (a file with `functions` holds several). */
export const ACTIONS_BY_FILE = {
  ask_user: ['ask_user'],
  create_task: ['create_task'],
  delete_scheduled_task: ['delete_scheduled_task'],
  evidence: ['evidence_collect', 'evidence_validateQuotesFastPath', 'evidence_composeReport'],
  get_task_run: ['get_task_run'],
  knowledge: ['knowledge_search', 'knowledge_read', 'knowledge_list'],
  list_scheduled_tasks: ['list_scheduled_tasks'],
  list_task_runs: ['list_task_runs'],
  list_tasks: ['list_tasks'],
  mark_task_done: ['mark_task_done'],
  read_inbox: ['read_inbox'],
  read_memory: ['read_memory'],
  run_scheduled_task_now: ['run_scheduled_task_now'],
  schedule_task: ['schedule_task'],
  update_scheduled_task: ['update_scheduled_task'],
  write_artifact: ['write_artifact'],
  write_inbox: ['write_inbox'],
  write_memory: ['write_memory']
};

export async function precondition(ctx) {
  if (await ctx.fileExists(INTEGRATIONS_FILE)) return true;
  for (const id of Object.keys(SHIPPED_HASHES)) {
    if (await ctx.fileExists(`tools/${id}.json`)) return true;
  }
  return false;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sortKeys(value[key])])
    );
  }
  return value;
}

/**
 * The hash of a tool file's content the way {@link SHIPPED_HASHES} was taken.
 * @param {object} tool - parsed tool file
 * @param {(text: string) => string} sha256 - hex digest
 */
export function contentHash(tool, sha256) {
  const { enabled: _enabled, ...rest } = tool || {};
  return sha256(JSON.stringify(sortKeys(rest)));
}

/** The installation as the migration creates it. */
export function ihubInstance(disabledActions = []) {
  return {
    id: INSTANCE_ID,
    definition: DEFINITION,
    definitionVersion: DEFINITION_VERSION,
    enabled: true,
    values: {},
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [...disabledActions], overrides: {} },
    allowedGroups: []
  };
}

/**
 * @param {object} ctx - migration context
 * @param {{ sha256?: (text: string) => string }} [deps] - hashing (node:crypto when absent)
 */
export async function up(ctx, deps = {}) {
  let sha256 = deps.sha256;
  if (!sha256) {
    const { createHash } = await import('node:crypto');
    sha256 = text => createHash('sha256').update(text).digest('hex');
  }

  const config = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(config.installed)) config.installed = [];
  if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };

  const disabled = new Set();
  const kept = [];
  for (const [id, shipped] of Object.entries(SHIPPED_HASHES)) {
    const rel = `tools/${id}.json`;
    if (!(await ctx.fileExists(rel))) continue;
    const tool = await ctx.readJson(rel);
    if (tool && contentHash(tool, sha256) === shipped) {
      if (tool.enabled === false) {
        for (const action of ACTIONS_BY_FILE[id]) disabled.add(action);
      }
      await ctx.deleteFile(rel);
      ctx.log(
        `${rel} removed: the ihub installation owns the tool${tool.enabled === false ? ' (switched off there, as it was here)' : ''}`
      );
    } else {
      kept.push(rel);
    }
  }

  let instance = config.installed.find(inst => inst?.id === INSTANCE_ID);
  if (!instance) {
    const now = new Date().toISOString();
    instance = { ...ihubInstance([...disabled]), installedAt: now, updatedAt: now };
    config.installed.push(instance);
    ctx.log(`Installed integration "${INSTANCE_ID}" created (${DEFINITION})`);
  } else if (disabled.size) {
    if (!instance.actions) instance.actions = { enabled: ['*'], disabled: [], overrides: {} };
    instance.actions.disabled = [...new Set([...(instance.actions.disabled || []), ...disabled])];
    instance.updatedAt = new Date().toISOString();
  }
  await ctx.writeJson(INTEGRATIONS_FILE, config);

  if (kept.length) {
    ctx.warn(
      `${kept.length} tool file(s) were edited by an admin and are kept: ${kept.join(', ')}. Each keeps serving its tool in place of the ihub installation's action; move the change over (Admin → Integrations → Installed → iHub) and delete the file.`
    );
  }
}
