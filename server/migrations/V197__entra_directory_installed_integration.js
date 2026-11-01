// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V197 — the Entra people search becomes the built-in installed
 * integration `entra`
 *
 * The `entraPeopleSearch` tool was configured through the environment only
 * (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`). It becomes the
 * installation `entra` (definition `com.intrafind/entra-directory`): tenant and
 * client id are copied from the environment when set, the secret stays in the
 * environment until an admin points the installation at a credential, and the
 * installation is enabled only when all three variables were present. The
 * tool file `tools/entraPeopleSearch.json` is retired (the installation owns
 * the tools, same ids) and an app that listed `entraPeopleSearch` or
 * `entraPeopleSearch_*` in `tools` binds the installation instead.
 */

export const version = '197';
export const description = 'entra_directory_installed_integration';

const INTEGRATIONS_FILE = 'config/integrations.json';
const TOOL_FILE = 'tools/entraPeopleSearch.json';
const INSTANCE_ID = 'entra';
const DEFINITION = 'com.intrafind/entra-directory';
const TOOL_ID = 'entraPeopleSearch';
export const ENTRA_ACTIONS = [
  'findUser',
  'getAllUserDetails',
  'getUserManager',
  'getUserGroups',
  'getTeamMembers',
  'getUserPhotoBase64'
];

export async function precondition(ctx) {
  if (await ctx.fileExists(INTEGRATIONS_FILE)) return true;
  if (await ctx.fileExists(TOOL_FILE)) return true;
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The installation the environment becomes.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function entraInstanceFrom(env = process.env) {
  const values = {};
  if (text(env.AZURE_TENANT_ID)) values.tenantId = text(env.AZURE_TENANT_ID);
  if (text(env.AZURE_CLIENT_ID)) values.clientId = text(env.AZURE_CLIENT_ID);
  return {
    id: INSTANCE_ID,
    definition: DEFINITION,
    definitionVersion: '1.0.0',
    enabled: Boolean(values.tenantId && values.clientId && text(env.AZURE_CLIENT_SECRET)),
    values,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    allowedGroups: []
  };
}

/**
 * `tools` entries `entraPeopleSearch` (all functions) and
 * `entraPeopleSearch_<fn>` become the binding `integrations.entra`.
 * @param {object} app
 * @returns {object} the app, or the same object when nothing applied
 */
export function migrateApp(app) {
  if (!Array.isArray(app?.tools)) return app;
  const names = new Set();
  let all = false;
  const kept = [];
  for (const ref of app.tools) {
    if (ref === TOOL_ID) {
      all = true;
    } else if (typeof ref === 'string' && ref.startsWith(`${TOOL_ID}_`)) {
      const name = ref.slice(TOOL_ID.length + 1);
      if (ENTRA_ACTIONS.includes(name)) names.add(name);
    } else {
      kept.push(ref);
    }
  }
  if (!all && names.size === 0 && kept.length === app.tools.length) return app;
  const next = { ...app, tools: kept };
  if (kept.length === 0) delete next.tools;
  if (all || names.size) {
    const integrations = { ...(app.integrations || {}) };
    const existing = integrations[INSTANCE_ID] || {};
    const binding = { ...existing };
    if (all || names.size === ENTRA_ACTIONS.length) delete binding.actions;
    else binding.actions = Array.from(new Set([...(existing.actions || []), ...names]));
    integrations[INSTANCE_ID] = binding;
    next.integrations = integrations;
  }
  return next;
}

export async function up(ctx, env = process.env) {
  // 1. The installation
  const config = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(config.installed)) config.installed = [];
  if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };
  if (!config.installed.some(inst => inst?.id === INSTANCE_ID)) {
    const now = new Date().toISOString();
    const instance = entraInstanceFrom(env);
    config.installed.push({ ...instance, installedAt: now, updatedAt: now });
    ctx.log(
      `Installed integration "${INSTANCE_ID}" created (${DEFINITION}, ${instance.enabled ? 'enabled from AZURE_* variables' : 'disabled: no AZURE_* variables'})`
    );
    await ctx.writeJson(INTEGRATIONS_FILE, config);
  }

  // 2. The tool file: the installation owns the tools
  if (await ctx.fileExists(TOOL_FILE)) {
    await ctx.deleteFile(TOOL_FILE);
    ctx.log(`${TOOL_FILE} removed: the Entra directory installation owns these tools`);
  }

  // 3. Apps bind the installation
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const rel = `apps/${file}`;
    const app = await ctx.readJson(rel);
    const next = migrateApp(app);
    if (next !== app) {
      await ctx.writeJson(rel, next);
      ctx.log(`${rel}: entraPeopleSearch tools → integrations.entra binding`);
    }
  }
}
