// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V211 — admin-created tool files become custom integrations
 * (#2915 item 1, #2975)
 *
 * The Tools admin page and `/api/admin/tools*` are removed (concept 03,
 * decision 8, clean break). Every tool file in `contents/tools/` that an
 * admin created — a script tool (one function or several `functions`) or an
 * OpenAPI tool (`type: "openapi"`) — becomes a custom integration, which the
 * integration builder (**Admin → Integrations → Add manually**) edits:
 *
 * - a definition `custom/<id>` in
 *   `contents/integration-definitions/custom__<id>/`:
 *   - script tool → protocol `script`; its connector module
 *     `actions/connector.js` is generated and runs the tool's script in
 *     `server/tools/` exactly as the tool did (`ctx.runToolScript`), one
 *     action per function;
 *   - OpenAPI tool → protocol `openapi`; an inline or file document is copied
 *     into the folder (`openapi.json` / `openapi.yaml`), a URL is kept as the
 *     document URL; the credential is sent as its profile says
 *     (`serviceAccount.kind: "credential"`);
 * - an installation `<id>` (enabled as the tool was) whose actions keep the
 *   tool ids (`toolId`: `myTool`, `myTool_search`), so apps, group grants,
 *   workflows, the MCP and A2A gateways and app approval overrides keep
 *   addressing them;
 * - the #2945 fields move with them: `sideEffect` and `dataFlow` onto the
 *   action (an undeclared data flow stays `internal`, as a tool file resolved
 *   to), `approval` / `requiresApproval` onto the installation's `approval`
 *   (a function's own setting per action, the tool's as the default);
 * - apps bind the installation (`integrations.<id>`, narrowed to `actions`
 *   when the app named single functions) instead of listing the tool in
 *   `tools`;
 * - every group with an explicit `permissions.integrations` list (no `*`)
 *   gets the installation, because the tool was usable by everyone who could
 *   open an app that listed it;
 * - the tool file is deleted.
 *
 * Shipped and platform tools stay as they are (the ids below, provider
 * tools `isSpecialTool`, agent tools `isAgentTool`): they belong to iHub, not
 * to the admin. A file that cannot be read, has no id, or whose id cannot be
 * kept as a tool id is reported and left in place.
 *
 * Idempotent: a tool file whose integration exists (`custom/<id>` installed
 * under the id) is only finished (bindings, groups, file removal); without
 * tool files the migration does nothing.
 *
 * Self-contained: no application module is imported (see
 * `server/migrations/README.md`); text files are written with `node:fs`
 * under `ctx.contentsDir` unless the context brings `writeText` / `readText`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const version = '211';
export const description = 'tools_to_custom_integrations';

const INTEGRATIONS_FILE = 'config/integrations.json';
const GROUPS_FILE = 'config/groups.json';
const DEFINITIONS_DIR = 'integration-definitions';
const MODULE_FILE = 'actions/connector.js';

/**
 * Tool ids iHub shipped at one time (snapshot 2026-11-02): the iHub, platform,
 * web search, people directory, Jira and iFinder tools, and the retired ones
 * earlier migrations removed. A file with one of these ids is iHub's, not an
 * admin's, and stays. Do NOT replace with a lookup of the live code.
 */
export const SHIPPED_TOOL_IDS = Object.freeze([
  'answerReducer',
  'ask_user',
  'braveSearch',
  'create_task',
  'deepResearch',
  'delete_scheduled_task',
  'enhancedWebSearch',
  'entraPeopleSearch',
  'evaluator',
  'evidence',
  'get_task_run',
  'googleSearch',
  'iFinder',
  'jira',
  'knowledge',
  'list_scheduled_tasks',
  'list_task_runs',
  'list_tasks',
  'mark_task_done',
  'playwrightScreenshot',
  'queryRewriter',
  'qwantSearch',
  'read_inbox',
  'read_memory',
  'read_url',
  'researchPlanner',
  'run_scheduled_task_now',
  'schedule_task',
  'seleniumScreenshot',
  'staanSearch',
  'tavilySearch',
  'update_scheduled_task',
  'webContentExtractor',
  'webSearch',
  'write_artifact',
  'write_inbox',
  'write_memory'
]);

const TOOL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const ACTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const APPROVAL_MODES = ['never', 'writes', 'always'];
const SIDE_EFFECTS = ['read', 'write', 'destructive', 'unknown'];
const DATA_FLOWS = ['internal', 'external'];

export async function precondition(ctx) {
  const files = await ctx.listFiles('tools', '*.json');
  return files.length > 0;
}

/** Whether a tool file is iHub's (shipped, platform, provider or agent tool). */
export function isShippedTool(tool) {
  return (
    SHIPPED_TOOL_IDS.includes(tool?.id) ||
    tool?.isSpecialTool === true ||
    tool?.isAgentTool === true
  );
}

/** Whether a tool file is one this migration turns into a custom integration. */
export function isMigratableTool(tool) {
  if (!tool || typeof tool !== 'object' || typeof tool.id !== 'string' || !tool.id) return false;
  if (isShippedTool(tool)) return false;
  if (tool.type === 'openapi') return Boolean(tool.openapi?.operationId);
  return !tool.type || tool.type === 'script';
}

/**
 * The installation id for a tool id: lower-case letters, digits and `-`
 * (what the builder takes), at most 48 characters.
 * @param {string} toolId
 * @returns {string}
 */
export function slugOf(toolId) {
  const slug = String(toolId)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : `tool-${slug}`.slice(0, 48);
}

/** An action name from a tool id or function name (letters, digits, `_`). */
export function actionNameOf(value) {
  let name = String(value).replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(name)) name = `a_${name}`;
  return name.slice(0, 64);
}

function localized(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return { en: value };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [lang, text] of Object.entries(value)) {
      if (typeof text === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) out[lang] = text;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** A JSON schema object a definition accepts (`type: "object"`). */
function schemaOf(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { type: 'object', properties: {}, required: [] };
  }
  return { ...parameters, type: 'object', properties: parameters.properties || {} };
}

/** The approval mode a tool or function asks for, or undefined. */
function approvalOf(entry) {
  if (APPROVAL_MODES.includes(entry?.approval)) return entry.approval;
  if (entry?.requiresApproval === true) return 'always';
  return undefined;
}

/**
 * The actions of a tool file: `[{ action, method, approval }]`, one per
 * function, else one for the tool.
 */
export function actionsOf(tool) {
  const toolSide = SIDE_EFFECTS.includes(tool.sideEffect) ? tool.sideEffect : undefined;
  const toolFlow = DATA_FLOWS.includes(tool.dataFlow) ? tool.dataFlow : undefined;
  if (tool.type !== 'openapi' && tool.functions && typeof tool.functions === 'object') {
    return Object.entries(tool.functions).map(([fn, cfg]) => ({
      action: compact({
        name: actionNameOf(fn),
        toolId: `${tool.id}_${fn}`,
        title: localized(cfg?.name),
        description: localized(cfg?.description) || localized(tool.description),
        parameters: schemaOf(cfg?.parameters),
        sideEffect: SIDE_EFFECTS.includes(cfg?.sideEffect) ? cfg.sideEffect : toolSide || 'unknown',
        dataFlow: DATA_FLOWS.includes(cfg?.dataFlow) ? cfg.dataFlow : toolFlow || 'internal'
      }),
      method: fn,
      approval: approvalOf(cfg)
    }));
  }
  const base = {
    name: actionNameOf(tool.id),
    toolId: tool.id,
    description: localized(tool.description),
    sideEffect: toolSide || 'unknown',
    dataFlow: toolFlow || 'internal'
  };
  if (tool.type === 'openapi') {
    const hideFields = tool.openapi?.xDisplay?.hideFields;
    return [
      {
        action: compact({
          ...base,
          operationId: tool.openapi.operationId,
          hideFields: Array.isArray(hideFields) && hideFields.length ? hideFields : undefined
        }),
        approval: approvalOf(tool)
      }
    ];
  }
  return [
    {
      action: compact({ ...base, parameters: schemaOf(tool.parameters) }),
      method: tool.method,
      approval: approvalOf(tool)
    }
  ];
}

/**
 * The connector module of a script tool: every action runs the tool's script
 * in `server/tools/` through `ctx.runToolScript`, with the function the tool
 * file named.
 * @param {object} tool
 * @param {Array} actions - {@link actionsOf}
 * @param {string} file - the tool file it came from (for the comment)
 */
export function connectorModuleOf(tool, actions, file) {
  const script = typeof tool.script === 'string' && tool.script ? tool.script : `${tool.id}.js`;
  const lines = actions.map(({ action, method }) => {
    const options = method ? `{ method: ${JSON.stringify(method)} }` : '{}';
    return `    ${JSON.stringify(action.name)}: {\n      run: (args, ctx) => ctx.runToolScript(${JSON.stringify(script)}, ${options})\n    }`;
  });
  return [
    `// Generated by migration V211 from contents/tools/${file}.`,
    `// Each action runs the tool script server/tools/${script} as the tool did.`,
    '// Edit it under Admin → Integrations → Edit in builder; ctx.runToolScript(script,',
    "// { method }) calls one of iHub's tool scripts, ctx.values holds the install values.",
    'export default {',
    '  actions: {',
    lines.join(',\n'),
    '  }',
    '};',
    ''
  ].join('\n');
}

/**
 * The definition folder of a tool: `{ definition, files }` where `files`
 * maps relative paths to text (the definition itself is in `definition`).
 *
 * @param {object} tool
 * @param {string} instanceId
 * @param {string} file - the tool file name
 * @param {(relPath: string) => Promise<string|null>} readText - reads `contents/<relPath>`
 * @param {(message: string) => void} warn
 */
export async function definitionOf(tool, instanceId, file, readText, warn) {
  const actions = actionsOf(tool);
  const files = {};
  const base = {
    id: `custom/${instanceId}`,
    version: '1.0.0',
    name: localized(tool.name) || { en: tool.id },
    description: localized(tool.description),
    categories: ['custom'],
    capabilities: ['tools'],
    actions: actions.map(entry => entry.action)
  };
  if (tool.type === 'openapi') {
    const openapi = tool.openapi || {};
    const source = openapi.source || {};
    let document;
    if (source.type === 'url' && /^https?:\/\//i.test(source.url || '')) {
      document = source.url;
    } else if (source.type === 'inline' && source.spec) {
      if (typeof source.spec === 'string') {
        const json = /^\s*[[{]/.test(source.spec);
        document = json ? 'openapi.json' : 'openapi.yaml';
        files[document] = source.spec;
      } else {
        document = 'openapi.json';
        files[document] = JSON.stringify(source.spec, null, 2);
      }
    } else if (source.type === 'file' && source.path) {
      const text = await readText(source.path);
      if (text === null) {
        warn(`tools/${file}: the OpenAPI file "${source.path}" cannot be read`);
        return null;
      }
      document = /\.ya?ml$/i.test(source.path) ? 'openapi.yaml' : 'openapi.json';
      files[document] = text;
    } else {
      warn(`tools/${file}: the OpenAPI tool has no usable source`);
      return null;
    }
    const credentialRef = openapi.auth?.credentialRef;
    const headers = {};
    for (const [name, value] of Object.entries(openapi.headers || {})) {
      if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) && String(value).length <= 1024) {
        headers[name] = String(value);
      } else {
        warn(`tools/${file}: the header "${name}" is not carried over (not a valid header)`);
      }
    }
    const definition = compact({
      ...base,
      protocol: compact({
        type: 'openapi',
        document,
        baseUrl: openapi.baseUrl || undefined,
        headers: Object.keys(headers).length ? headers : undefined,
        arrayParameterStyle:
          openapi.arrayStyle && openapi.arrayStyle !== 'openapi' ? openapi.arrayStyle : undefined,
        maxResponseBytes: openapi.maxResponseBytes,
        timeoutMs: openapi.timeoutMs
      }),
      auth: credentialRef
        ? {
            modes: ['service-account'],
            serviceAccount: { kind: 'credential', field: 'secret' }
          }
        : { modes: ['none'] },
      install: credentialRef
        ? [
            {
              key: 'secret',
              type: 'secret',
              title: { en: 'Credential', de: 'Zugangsdaten' },
              required: true
            }
          ]
        : []
    });
    return { definition, files, actions, credentialRef, security: openapi.security };
  }
  files[MODULE_FILE] = connectorModuleOf(tool, actions, file);
  const definition = compact({
    ...base,
    protocol: { type: 'script', module: MODULE_FILE },
    auth: { modes: ['none'] },
    install: []
  });
  return { definition, files, actions };
}

/** The installation of a migrated tool. */
export function installationOf(tool, instanceId, actions, credentialRef, now) {
  const approvalActions = {};
  let approvalDefault;
  if (tool.functions && tool.type !== 'openapi') {
    approvalDefault = approvalOf(tool);
    for (const { action, approval } of actions) {
      if (approval) approvalActions[action.name] = approval;
    }
  } else {
    const [{ action, approval }] = actions;
    if (approval) approvalActions[action.name] = approval;
  }
  const approval = compact({
    default: approvalDefault,
    actions: Object.keys(approvalActions).length ? approvalActions : undefined
  });
  return compact({
    id: instanceId,
    definition: `custom/${instanceId}`,
    definitionVersion: '1.0.0',
    enabled: tool.enabled !== false,
    values: {},
    auth: credentialRef ? { mode: 'service-account', credentialRef } : { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    approval: Object.keys(approval).length ? approval : undefined,
    installedAt: now,
    updatedAt: now
  });
}

/** The part of a tool id before the first `_` (how app references select function tools). */
function baseIdOf(toolId) {
  return toolId.includes('_') ? toolId.split('_')[0] : toolId;
}

/**
 * Rewrite an app's tool references to a migrated tool into a binding.
 * A reference that is the tool id selects every action it selected before
 * (exact id, or the base id of a function's tool id); a reference that is one
 * action's tool id selects that action. Other references stay.
 *
 * @param {object} app
 * @param {Array<{ instanceId: string, toolId: string, actions: Array<{ name: string, toolId: string }> }>} migrated
 * @returns {object} the app, or the same object when nothing applied
 */
export function migrateApp(app, migrated) {
  if (!Array.isArray(app?.tools) || app.tools.length === 0) return app;
  const kept = [];
  const picks = new Map(); // instanceId → Set(action names) | 'all'
  for (const ref of app.tools) {
    const hit = migrated.find(
      m => m.toolId === ref || m.actions.some(action => action.toolId === ref)
    );
    if (!hit) {
      kept.push(ref);
      continue;
    }
    const selected = hit.actions.filter(
      action => action.toolId === ref || baseIdOf(action.toolId) === ref
    );
    if (selected.length === 0) continue;
    const current = picks.get(hit.instanceId);
    if (current === 'all') continue;
    if (selected.length === hit.actions.length) {
      picks.set(hit.instanceId, 'all');
      continue;
    }
    const names = current || new Set();
    for (const action of selected) names.add(action.name);
    picks.set(hit.instanceId, names);
  }
  if (kept.length === app.tools.length) return app;
  const next = { ...app, tools: kept };
  if (kept.length === 0) delete next.tools;
  const integrations = { ...(app.integrations || {}) };
  for (const [instanceId, pick] of picks) {
    const existing = integrations[instanceId] || {};
    const binding = { ...existing };
    if (pick === 'all') {
      delete binding.actions;
    } else if (!(instanceId in (app.integrations || {})) || Array.isArray(existing.actions)) {
      binding.actions = [...new Set([...(existing.actions || []), ...pick])];
    }
    integrations[instanceId] = binding;
  }
  next.integrations = integrations;
  return next;
}

/** Grant the installations to every group with an explicit list. Returns whether it changed. */
export function grantToGroups(groupsConfig, instanceIds) {
  let changed = false;
  for (const group of Object.values(groupsConfig?.groups || {})) {
    const list = group?.permissions?.integrations;
    if (!Array.isArray(list) || list.includes('*')) continue;
    for (const id of instanceIds) {
      if (!list.includes(id)) {
        list.push(id);
        changed = true;
      }
    }
  }
  return changed;
}

/** Whether the definition folder of `instanceId` keeps exactly these tool ids. */
async function keepsToolIds(readText, instanceId, toolIds) {
  const text = await readText(`${DEFINITIONS_DIR}/custom__${instanceId}/integration.json`);
  if (!text) return false;
  try {
    const kept = (JSON.parse(text).actions || []).map(action => action.toolId).sort();
    const wanted = [...toolIds].sort();
    return kept.length === wanted.length && kept.every((id, i) => id === wanted[i]);
  } catch {
    return false;
  }
}

function fsReadText(contentsDir) {
  return async relPath => {
    const root = path.resolve(contentsDir);
    const target = path.resolve(root, relPath);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    try {
      return await fs.readFile(target, 'utf8');
    } catch {
      return null;
    }
  };
}

function fsWriteText(contentsDir) {
  return async (relPath, text) => {
    const target = path.join(contentsDir, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
  };
}

export async function up(ctx) {
  const readText = ctx.readText || fsReadText(ctx.contentsDir);
  const writeText = ctx.writeText || fsWriteText(ctx.contentsDir);
  const now = new Date().toISOString();

  const config = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(config.installed)) config.installed = [];
  if (!config.security) config.security = { blockPrivateIps: true, allowedHosts: [] };
  const security = config.security;
  if (!Array.isArray(security.allowedHosts)) security.allowedHosts = [];
  let configChanged = false;

  const migrated = [];
  const toDelete = [];
  /** Installation ids this run gave out, so two tools never share one. */
  const claimed = new Set();
  for (const file of (await ctx.listFiles('tools', '*.json')).sort()) {
    const rel = `tools/${file}`;
    let tool;
    try {
      tool = await ctx.readJson(rel);
    } catch {
      ctx.warn(`${rel}: unreadable, left in place`);
      continue;
    }
    if (!isMigratableTool(tool)) continue;
    if (!TOOL_ID_PATTERN.test(tool.id)) {
      ctx.warn(`${rel}: the tool id "${tool.id}" cannot be kept as a tool id; left in place`);
      continue;
    }

    const toolIds = actionsOf(tool).map(({ action }) => action.toolId);
    // A re-run finds the installation it made: same slug, its definition
    // keeping exactly this tool's ids. Any other holder of the id is a
    // collision, and the next free `<slug>-<n>` is taken.
    const slug = slugOf(tool.id);
    let instanceId = slug;
    let existing = null;
    for (let n = 2; ; n += 1) {
      const holder = config.installed.find(inst => inst?.id === instanceId);
      if (!holder) break;
      if (
        holder.definition === `custom/${instanceId}` &&
        !claimed.has(instanceId) &&
        (await keepsToolIds(readText, instanceId, toolIds))
      ) {
        existing = holder;
        break;
      }
      instanceId = `${slug.slice(0, 44)}-${n}`;
    }
    claimed.add(instanceId);

    const built = await definitionOf(tool, instanceId, file, readText, ctx.warn);
    if (!built) continue;
    const { definition, files, actions } = built;
    const names = actions.map(({ action }) => action.name);
    if (new Set(names).size !== names.length) {
      ctx.warn(`${rel}: two functions map to the same action name; left in place`);
      continue;
    }
    if (actions.some(({ action }) => !ACTION_NAME_PATTERN.test(action.name))) {
      ctx.warn(`${rel}: a function name cannot be an action name; left in place`);
      continue;
    }

    if (!existing) {
      const dir = `${DEFINITIONS_DIR}/custom__${instanceId}`;
      for (const [relPath, text] of Object.entries(files)) {
        await writeText(`${dir}/${relPath}`, text);
      }
      await writeText(`${dir}/integration.json`, `${JSON.stringify(definition, null, 2)}\n`);
      config.installed.push(
        installationOf(tool, instanceId, actions, built.credentialRef || null, now)
      );
      // The tool's own SSRF exceptions apply to the installation's requests now.
      for (const host of built.security?.allowedHosts || []) {
        if (typeof host === 'string' && host && !security.allowedHosts.includes(host)) {
          security.allowedHosts.push(host);
        }
      }
      if (built.security?.blockPrivateIps === false) {
        ctx.warn(
          `${rel}: the tool allowed private addresses (blockPrivateIps: false); add its host to the integrations' allowed hosts if it needs one`
        );
      }
      configChanged = true;
      ctx.log(`${rel} → custom integration "${instanceId}" (${definition.protocol.type})`);
      for (const key of ['passthrough', 'concurrency', 'requestDelayMs']) {
        if (tool[key] !== undefined && tool[key] !== false) {
          ctx.warn(`${rel}: "${key}" is not carried over to the integration`);
        }
      }
    }
    migrated.push({
      instanceId,
      toolId: tool.id,
      actions: actions.map(({ action }) => ({ name: action.name, toolId: action.toolId }))
    });
    toDelete.push(rel);
  }

  if (migrated.length === 0) return;
  if (configChanged) await ctx.writeJson(INTEGRATIONS_FILE, config);

  if (await ctx.fileExists(GROUPS_FILE)) {
    const groups = await ctx.readJson(GROUPS_FILE);
    if (
      grantToGroups(
        groups,
        migrated.map(m => m.instanceId)
      )
    ) {
      await ctx.writeJson(GROUPS_FILE, groups);
      ctx.log('groups with an explicit integrations list were granted the migrated tools');
    }
  }

  for (const file of await ctx.listFiles('apps', '*.json')) {
    const rel = `apps/${file}`;
    let app;
    try {
      app = await ctx.readJson(rel);
    } catch {
      continue;
    }
    const next = migrateApp(app, migrated);
    if (next !== app) {
      await ctx.writeJson(rel, next);
      ctx.log(`${rel}: migrated tools → integrations bindings`);
    }
  }

  for (const rel of toDelete) {
    await ctx.deleteFile(rel);
  }
}
