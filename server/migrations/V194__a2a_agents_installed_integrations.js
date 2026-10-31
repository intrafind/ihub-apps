// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V194 — remote A2A agents become installed integrations
 *
 * Every agent of `config/a2aAgents.json` becomes an installation of the
 * shipped `com.intrafind/a2a-agent` definition in `config/integrations.json`,
 * under the same id, so its tool ids (`a2a__<id>__<skill>`) and group grants
 * stay valid:
 *
 * - `auth` maps to the sign-in mode: apiKey and bearer → service account
 *   (credential reference kept), oauth → OAuth client;
 * - `allowedSkills` → `actions.enabled`; `security` merges into the
 *   integrations file.
 *
 * Apps bind the installation instead of listing the agent (`tools:
 * ["langdock"]` or `["a2a__langdock"]` → `integrations.langdock`); a skill
 * reference (`a2a__langdock__ask`) also becomes the binding of the whole
 * agent, because the skill ids behind the slugs are only known from the card.
 *
 * `config/a2aAgents.json` is removed; nothing reads it any more. An agent whose
 * id another installation already holds is not moved: it is written to
 * `config/a2aAgents.unmigrated.json` with a warning, for the admin to install
 * under a free id.
 */

export const version = '194';
export const description = 'a2a_agents_installed_integrations';

const A2A_FILE = 'config/a2aAgents.json';
/** Agents the migration could not move, for the admin to re-install by hand. */
const UNMIGRATED_FILE = 'config/a2aAgents.unmigrated.json';
const INTEGRATIONS_FILE = 'config/integrations.json';
const DEFINITION = 'com.intrafind/a2a-agent';
const DEFAULTS = { timeoutMs: 60000, streaming: 'auto', pollIntervalMs: 1500 };

export async function precondition(ctx) {
  if (await ctx.fileExists(A2A_FILE)) return true;
  const apps = await ctx.listFiles('apps', '*.json');
  return apps.length > 0;
}

function nonEmpty(value) {
  return value !== undefined && value !== null && value !== '';
}

function put(values, key, value) {
  if (nonEmpty(value)) values[key] = value;
}

function localizedOf(value) {
  if (!nonEmpty(value)) return undefined;
  return typeof value === 'string' ? { en: value } : value;
}

/** The sign-in mode of an `a2aAgents.json` auth block. */
export function authModeOf(auth) {
  switch (auth?.type) {
    case 'apiKey':
    case 'bearer':
      return 'service-account';
    case 'oauth':
      return 'oauth-client';
    default:
      return 'none';
  }
}

/** The installation an `a2aAgents.json` agent becomes. */
export function instanceFrom(agent) {
  const auth = agent.auth || { type: 'none' };
  const mode = authModeOf(auth);
  const values = {};
  put(values, 'cardUrl', agent.cardUrl);
  if (mode === 'service-account') {
    values.authKind = auth.type;
    if (auth.type === 'apiKey') put(values, 'headerName', auth.headerName);
  }
  if (mode === 'oauth-client') {
    put(values, 'oauthTokenUrl', auth.tokenUrl);
    put(values, 'oauthClientId', auth.clientId);
    put(values, 'oauthScope', auth.scope);
  }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (agent[key] !== undefined && agent[key] !== fallback) values[key] = agent[key];
  }
  const instance = {
    id: agent.id,
    definition: DEFINITION,
    enabled: agent.enabled !== false,
    values,
    auth: { mode },
    actions: {
      enabled:
        Array.isArray(agent.allowedSkills) && !agent.allowedSkills.includes('*')
          ? agent.allowedSkills
          : ['*'],
      disabled: [],
      overrides: {}
    },
    allowedGroups: []
  };
  const label = localizedOf(agent.name);
  if (label) instance.label = label;
  const desc = localizedOf(agent.description);
  if (desc) instance.description = desc;
  const credentialRef = auth.valueRef || auth.tokenRef || auth.clientSecretRef;
  if (mode !== 'none' && credentialRef) instance.auth.credentialRef = credentialRef;
  return instance;
}

/**
 * Rewrite an app's agent references to bindings. Returns the app and whether
 * it changed.
 * @param {object} app
 * @param {string[]} agentIds
 */
export function migrateApp(app, agentIds) {
  if (!Array.isArray(app?.tools) || app.tools.length === 0) return { app, changed: false };
  const ids = new Set(agentIds);
  const bindings = { ...(app.integrations || {}) };
  const kept = [];
  let changed = false;
  for (const ref of app.tools) {
    if (typeof ref !== 'string') {
      kept.push(ref);
      continue;
    }
    let agentId = null;
    if (ids.has(ref)) agentId = ref;
    else if (ref.startsWith('a2a__')) {
      const rest = ref.slice('a2a__'.length);
      const candidate = rest.includes('__') ? rest.slice(0, rest.indexOf('__')) : rest;
      if (ids.has(candidate)) agentId = candidate;
    }
    if (!agentId) {
      kept.push(ref);
      continue;
    }
    const binding = { ...(bindings[agentId] || {}) };
    delete binding.actions;
    bindings[agentId] = binding;
    changed = true;
  }
  if (!changed) return { app, changed: false };
  const next = { ...app, tools: kept, integrations: bindings };
  if (next.tools.length === 0) delete next.tools;
  return { app: next, changed: true };
}

export async function up(ctx) {
  const hadFile = await ctx.fileExists(A2A_FILE);
  const a2a = hadFile ? (await ctx.readJson(A2A_FILE)) || {} : {};
  const agents = Array.isArray(a2a.agents) ? a2a.agents.filter(a => a && a.id) : [];

  const integrations = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(integrations.installed)) integrations.installed = [];
  if (!integrations.security) {
    integrations.security = { blockPrivateIps: true, allowedHosts: [] };
  }

  let migrated = 0;
  const skipped = [];
  for (const agent of agents) {
    if (integrations.installed.some(inst => inst.id === agent.id)) {
      // Another installation (an MCP server V193 moved, an installed catalog
      // integration) holds the id. The agent cannot take it; it is kept in a
      // side file below instead of being lost with a2aAgents.json.
      skipped.push(agent);
      continue;
    }
    const instance = instanceFrom(agent);
    const now = new Date().toISOString();
    instance.installedAt = now;
    instance.updatedAt = now;
    integrations.installed.push(instance);
    migrated += 1;
    ctx.log(`A2A agent "${agent.id}" → installed integration (${DEFINITION})`);
  }
  if (a2a.security) {
    integrations.security.blockPrivateIps =
      integrations.security.blockPrivateIps !== false && a2a.security.blockPrivateIps !== false;
    integrations.security.allowedHosts = [
      ...new Set([
        ...(integrations.security.allowedHosts || []),
        ...(a2a.security.allowedHosts || [])
      ])
    ];
  }
  if (hadFile || migrated > 0) await ctx.writeJson(INTEGRATIONS_FILE, integrations);

  const agentIds = integrations.installed
    .filter(inst => inst.definition === DEFINITION)
    .map(inst => inst.id);
  if (agentIds.length) {
    for (const file of await ctx.listFiles('apps', '*.json')) {
      const rel = `apps/${file}`;
      const app = await ctx.readJson(rel);
      if (!app) continue;
      const { app: next, changed } = migrateApp(app, agentIds);
      if (changed) {
        await ctx.writeJson(rel, next);
        ctx.log(`${rel}: A2A agent references → integrations binding`);
      }
    }
  }

  if (skipped.length) {
    await ctx.writeJson(UNMIGRATED_FILE, {
      ...(a2a.security ? { security: a2a.security } : {}),
      agents: skipped
    });
    ctx.warn(
      `${skipped.length} A2A agent(s) not migrated because an installed integration already has the id: ${skipped
        .map(agent => `"${agent.id}"`)
        .join(
          ', '
        )}. Kept in ${UNMIGRATED_FILE}; install each under a free id and bind it to its apps.`
    );
  }
  if (hadFile) {
    await ctx.deleteFile(A2A_FILE);
    ctx.log(`${A2A_FILE} removed: A2A agents are installed integrations now`);
  }
}
