// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V196 — Jira becomes the built-in installed integration `jira`
 *
 * `platform.jira` (client id, client secret reference, redirect URI, site URL,
 * enabled) moves into `config/integrations.json` as the installation `jira`
 * (definition `com.intrafind/jira`) and leaves platform.json. The six tools
 * keep their ids (`jira_searchTickets`, …) as the installation's actions, so a
 * hand-written tool file for `tools/jira.js` is retired and an app that listed
 * `jira` or `jira_*` in `tools` binds the installation instead. Users' Jira
 * tokens are untouched.
 */

export const version = '196';
export const description = 'jira_installed_integration';

const PLATFORM_FILE = 'config/platform.json';
const INTEGRATIONS_FILE = 'config/integrations.json';
const INSTANCE_ID = 'jira';
const DEFINITION = 'com.intrafind/jira';
export const JIRA_ACTIONS = [
  'searchTickets',
  'getTicket',
  'addComment',
  'getTransitions',
  'transitionTicket',
  'getAttachment'
];

export async function precondition(ctx) {
  if (await ctx.fileExists(PLATFORM_FILE)) return true;
  if ((await ctx.listFiles('tools', '*.json')).length > 0) return true;
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The installation `platform.jira` becomes. Disabled when the block was off or
 * never filled in, so an upgrade never switches Jira on.
 * @param {object} [jira] - the former `platform.jira`
 */
export function jiraInstanceFrom(jira = {}) {
  const values = {};
  if (text(jira.clientId)) values.clientId = text(jira.clientId);
  if (text(jira.clientSecretRef)) values.clientSecretRef = text(jira.clientSecretRef);
  if (text(jira.redirectUri)) values.redirectUri = text(jira.redirectUri);
  if (text(jira.baseUrl)) values.siteUrl = text(jira.baseUrl);
  return {
    id: INSTANCE_ID,
    definition: DEFINITION,
    definitionVersion: '1.0.0',
    enabled: jira.enabled === true && Boolean(values.clientId && values.clientSecretRef),
    values,
    auth: { mode: 'oauth-user' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    allowedGroups: []
  };
}

/**
 * An app's `tools` entries `jira` (all functions) and `jira_<fn>` become the
 * binding `integrations.jira`; nothing else in the app changes.
 * @param {object} app
 * @returns {object} the app, or the same object when nothing applied
 */
export function migrateApp(app) {
  if (!Array.isArray(app?.tools)) return app;
  const names = new Set();
  let all = false;
  const kept = [];
  for (const ref of app.tools) {
    if (ref === 'jira') {
      all = true;
    } else if (typeof ref === 'string' && ref.startsWith('jira_')) {
      const name = ref.slice('jira_'.length);
      if (JIRA_ACTIONS.includes(name)) names.add(name);
      // An unknown jira_* reference selects nothing any more and is dropped.
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
    if (all || names.size === JIRA_ACTIONS.length) delete binding.actions;
    else binding.actions = Array.from(new Set([...(existing.actions || []), ...names]));
    integrations[INSTANCE_ID] = binding;
    next.integrations = integrations;
  }
  return next;
}

export async function up(ctx) {
  // 1. The installation
  if (await ctx.fileExists(PLATFORM_FILE)) {
    const platform = await ctx.readJson(PLATFORM_FILE);
    if (platform && Object.prototype.hasOwnProperty.call(platform, 'jira')) {
      const config = (await ctx.fileExists(INTEGRATIONS_FILE))
        ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
        : {};
      if (!Array.isArray(config.installed)) config.installed = [];
      if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };
      if (!config.installed.some(inst => inst?.id === INSTANCE_ID)) {
        const now = new Date().toISOString();
        const instance = jiraInstanceFrom(platform.jira || {});
        config.installed.push({ ...instance, installedAt: now, updatedAt: now });
        ctx.log(
          `platform.jira → installed integration "${INSTANCE_ID}" (${instance.enabled ? 'enabled' : 'disabled'})`
        );
        await ctx.writeJson(INTEGRATIONS_FILE, config);
      }
      delete platform.jira;
      await ctx.writeJson(PLATFORM_FILE, platform);
    }
  }

  // 2. Hand-written tool files for the Jira script: the installation owns the tools
  for (const file of await ctx.listFiles('tools', '*.json')) {
    const rel = `tools/${file}`;
    let tool;
    try {
      tool = await ctx.readJson(rel);
    } catch {
      continue;
    }
    if (tool?.script === 'jira.js' || tool?.id === 'jira') {
      await ctx.deleteFile(rel);
      ctx.log(`${rel} removed: the Jira installation owns these tools`);
    }
  }

  // 3. Apps bind the installation
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const rel = `apps/${file}`;
    const app = await ctx.readJson(rel);
    const next = migrateApp(app);
    if (next !== app) {
      await ctx.writeJson(rel, next);
      ctx.log(`${rel}: Jira tools → integrations.jira binding`);
    }
  }
}
