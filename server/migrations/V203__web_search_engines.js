// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V203 — web search: one integration per engine
 *
 * V195 made web search one installation, `websearch` (definition
 * `com.intrafind/web-search`), holding every engine. From now on each engine
 * is an integration of its own, of type `web-search`, installed once under the
 * id `app.websearch.provider` always used: `brave`
 * (`com.intrafind/brave-search`), `staan` (`com.intrafind/staan-search`) and
 * `qwant` (`com.intrafind/qwant-search`). With no engine installed, an app with
 * web search on still uses the model's native search; the page reader
 * `read_url` belongs to the web search feature (a platform tool), not to an
 * engine.
 *
 * "Keep what worked" — the `websearch` installation becomes the engines that
 * could answer:
 *
 * - `brave` where a Brave key was configured: the credential the installation
 *   referenced (`braveCredentialRef`, moved to `apiKeyRef`) or the
 *   `BRAVE_SEARCH_API_KEY` environment variable;
 * - `staan` likewise (`staanCredentialRef`, `STAAN_API_KEY`);
 * - `qwant` where it was reachable: the installation's default engine was
 *   `auto` with neither key (Qwant was the fallback), or `qwant`, or an app
 *   named `qwant` (`websearch.provider`).
 *
 * Each engine takes over the enabled state of `websearch`, and an engine
 * whose action `websearch` had switched off gets its `search` action switched
 * off. A page reader `websearch` had switched off (`readUrl`) stays off
 * through `contents/tools/read_url.json` with `enabled: false`, which takes the
 * place of the shipped definition.
 *
 * When the installation's default engine was an explicit one, every app with
 * `websearch.provider` `auto` (or unset) is rewritten to that engine, so its
 * engine does not change (`auto` now takes the first engine the user may use).
 *
 * Grants by `websearch` or `com.intrafind/web-search` in `groups.json` →
 * `permissions.integrations` become `type:web-search` (every engine). App
 * references to the id `websearch` are stale and removed (an
 * `app.integrations` binding of `websearch` or `com.intrafind/web-search`, a
 * `tools` entry `websearch`). Then the `websearch` installation is removed.
 *
 * **Fresh install:** no engine. Initial setup ships no engine, but V195 creates
 * `websearch` (default `auto`, no key) in the same run, which would read as
 * "Qwant was reachable". So when the migration history began in this run (its
 * first entry is younger than {@link FRESH_RUN_WINDOW_MS}), the `auto` default
 * is not taken as evidence; keys and apps naming `qwant` still are.
 *
 * Example: `websearch` enabled, `braveCredentialRef: "integration-websearch-brave"`,
 * `defaultProvider: "brave"`, the group `anonymous` granted `["ihub", "websearch"]`
 * → installation `brave` with `apiKeyRef: "integration-websearch-brave"`, no
 * `qwant` (the default was not `auto`), apps on `auto` set to `brave`,
 * `anonymous` granted `["ihub", "type:web-search"]`, `websearch` removed.
 *
 * Idempotent: once `websearch` is gone only the group and app clean-ups run,
 * and they find nothing. Missing files are skipped. Self-contained: no
 * application module is imported (see `server/migrations/README.md`).
 */

export const version = '203';
export const description = 'web_search_engines';

const INTEGRATIONS_FILE = 'config/integrations.json';
const GROUPS_FILE = 'config/groups.json';
const CREDENTIALS_FILE = 'config/credentials.json';
const HISTORY_FILE = '.migration-history.json';
const READER_TOOL_FILE = 'tools/read_url.json';

const OLD_INSTANCE_ID = 'websearch';
const OLD_DEFINITION = 'com.intrafind/web-search';
const TYPE_KEY = 'type:web-search';
/** Old ids that grant or bind the umbrella installation. */
const OLD_KEYS = Object.freeze([OLD_INSTANCE_ID, OLD_DEFINITION]);

/**
 * The engines as of this migration (2026-11-01): the new installation, its
 * definition, the action of `websearch` it replaces, and where its key was.
 * Snapshot — do NOT replace with an import of the engine registry.
 */
export const ENGINES = Object.freeze([
  Object.freeze({
    id: 'brave',
    definition: 'com.intrafind/brave-search',
    oldAction: 'brave',
    keyField: 'braveCredentialRef',
    keyEnv: 'BRAVE_SEARCH_API_KEY'
  }),
  Object.freeze({
    id: 'staan',
    definition: 'com.intrafind/staan-search',
    oldAction: 'staan',
    keyField: 'staanCredentialRef',
    keyEnv: 'STAAN_API_KEY'
  }),
  Object.freeze({ id: 'qwant', definition: 'com.intrafind/qwant-search', oldAction: 'qwant' })
]);

const ENGINE_IDS = Object.freeze(ENGINES.map(engine => engine.id));
const DEFINITION_VERSION = '1.0.0';
/** The install field of a keyed engine that references its key. */
const API_KEY_FIELD = 'apiKeyRef';
/** The page reader's action on `websearch`. */
const OLD_READER_ACTION = 'readUrl';
/** The description V195 gave the credentials it created. */
const V195_CREDENTIAL_DESCRIPTION = `Managed by the installed integration "${OLD_INSTANCE_ID}"`;

/**
 * How young the first entry of the migration history may be for this run to
 * count as the one that set the install up from the shipped defaults. A fresh
 * install runs every migration within seconds.
 */
export const FRESH_RUN_WINDOW_MS = 15 * 60 * 1000;

export async function precondition(ctx) {
  if (await ctx.fileExists(INTEGRATIONS_FILE)) return true;
  if (await ctx.fileExists(GROUPS_FILE)) return true;
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether `websearch` offered one of its actions (`actions.enabled` /
 * `actions.disabled`, as the server read them).
 * @param {object} instance
 * @param {string} action
 * @returns {boolean}
 */
export function oldActionEnabled(instance, action) {
  const policy = instance?.actions || {};
  if (Array.isArray(policy.disabled) && policy.disabled.includes(action)) return false;
  const enabled = Array.isArray(policy.enabled) ? policy.enabled : ['*'];
  return enabled.includes(action) || enabled.includes('*');
}

/**
 * Whether the history of migrations began in this run: the install was set up
 * from the shipped defaults just now. A missing or unreadable history counts
 * as an existing install (keep what worked).
 *
 * @param {object} ctx
 * @param {number} now - ms since epoch
 * @returns {Promise<boolean>}
 */
export async function isFreshInstall(ctx, now = Date.now()) {
  if (!(await ctx.fileExists(HISTORY_FILE))) return false;
  let history;
  try {
    history = await ctx.readJson(HISTORY_FILE);
  } catch {
    return false;
  }
  const first = Array.isArray(history?.migrations) ? history.migrations[0] : null;
  const startedAt = Date.parse(first?.appliedAt);
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt <= FRESH_RUN_WINDOW_MS;
}

/**
 * The engine installations `websearch` becomes, and why.
 *
 * @param {object} websearch - the `websearch` installation
 * @param {object} [options]
 * @param {object[]} [options.apps] - every app (for `websearch.provider: "qwant"`)
 * @param {object} [options.env] - the environment (`process.env`)
 * @param {boolean} [options.fresh] - a fresh install (the `auto` default is no evidence)
 * @param {string} [options.now] - ISO timestamp for `installedAt` / `updatedAt`
 * @returns {{ engines: object[], reasons: Object<string, string>, skipped: Object<string, string>,
 *   defaultEngine: string|null, readerOff: boolean }}
 *   `defaultEngine`: the explicit default engine of `websearch`, or null for `auto`
 */
export function planEngines(websearch, { apps = [], env = {}, fresh = false, now } = {}) {
  const values = websearch?.values && typeof websearch.values === 'object' ? websearch.values : {};
  const defaultProvider = ENGINE_IDS.includes(values.defaultProvider)
    ? values.defaultProvider
    : 'auto';
  const keyOf = engine => {
    if (!engine.keyField) return null;
    if (nonEmptyString(values[engine.keyField])) return { ref: values[engine.keyField] };
    if (nonEmptyString(env?.[engine.keyEnv])) return { env: engine.keyEnv };
    return null;
  };
  const hasKey = id => Boolean(keyOf(ENGINES.find(engine => engine.id === id)));
  const appNamesQwant = apps.some(app => app?.websearch?.provider === 'qwant');

  const reasons = {};
  const skipped = {};
  for (const engine of ENGINES) {
    if (engine.keyField) {
      const key = keyOf(engine);
      if (key?.ref) reasons[engine.id] = `credential "${key.ref}"`;
      else if (key?.env) reasons[engine.id] = `environment variable ${key.env}`;
      else skipped[engine.id] = 'no API key was configured';
      continue;
    }
    // Qwant needs no key: it worked where something could reach it.
    if (defaultProvider === 'qwant') reasons.qwant = 'the default search engine was Qwant';
    else if (appNamesQwant) reasons.qwant = 'an app names Qwant';
    else if (defaultProvider === 'auto' && !hasKey('brave') && !hasKey('staan')) {
      if (fresh) skipped.qwant = 'fresh install: no engine is installed';
      else reasons.qwant = 'Auto used Qwant (no Brave or Staan key)';
    } else skipped.qwant = 'Qwant was not used';
  }

  const timestamp = now || new Date().toISOString();
  const engines = ENGINES.filter(engine => reasons[engine.id]).map(engine => {
    const key = keyOf(engine);
    return {
      id: engine.id,
      definition: engine.definition,
      definitionVersion: DEFINITION_VERSION,
      enabled: websearch?.enabled !== false,
      values: key?.ref ? { [API_KEY_FIELD]: key.ref } : {},
      auth: { mode: 'none' },
      actions: {
        enabled: ['*'],
        disabled: oldActionEnabled(websearch, engine.oldAction) ? [] : ['search'],
        overrides: {}
      },
      installedAt: timestamp,
      updatedAt: timestamp
    };
  });

  return {
    engines,
    reasons,
    skipped,
    defaultEngine: defaultProvider === 'auto' ? null : defaultProvider,
    readerOff: Boolean(websearch) && !oldActionEnabled(websearch, OLD_READER_ACTION)
  };
}

/**
 * An app without its stale references to `websearch`, and with its engine
 * pinned to the former default engine when it was on `auto`.
 *
 * @param {object} app
 * @param {string|null} defaultEngine - the explicit former default, or null
 * @returns {{ app: object, changes: string[] }} `changes` empty when nothing changed
 */
export function migrateApp(app, defaultEngine) {
  if (!app || typeof app !== 'object') return { app, changes: [] };
  const next = { ...app };
  const changes = [];

  if (defaultEngine && next.websearch && typeof next.websearch === 'object') {
    const provider = next.websearch.provider;
    if (provider === undefined || provider === null || provider === '' || provider === 'auto') {
      next.websearch = { ...next.websearch, provider: defaultEngine };
      changes.push(`websearch.provider "${provider || 'auto'}" → "${defaultEngine}"`);
    }
  }

  if (next.integrations && typeof next.integrations === 'object') {
    const stale = Object.keys(next.integrations).filter(key => OLD_KEYS.includes(key));
    if (stale.length) {
      const integrations = { ...next.integrations };
      for (const key of stale) delete integrations[key];
      if (Object.keys(integrations).length) next.integrations = integrations;
      else delete next.integrations;
      changes.push(`integration binding(s) ${stale.join(', ')} removed`);
    }
  }

  if (Array.isArray(next.tools) && next.tools.includes(OLD_INSTANCE_ID)) {
    const tools = next.tools.filter(ref => ref !== OLD_INSTANCE_ID);
    if (tools.length) next.tools = tools;
    else delete next.tools;
    changes.push(`tools entry "${OLD_INSTANCE_ID}" removed`);
  }

  return { app: changes.length ? next : app, changes };
}

/**
 * A group's `permissions.integrations` with the grants of `websearch` replaced
 * by `type:web-search` (in place of the first one, duplicates dropped).
 *
 * @param {string[]} grants
 * @returns {string[]|null} the new list, or null when nothing changes
 */
export function migrateGrants(grants) {
  if (!Array.isArray(grants) || !grants.some(key => OLD_KEYS.includes(key))) return null;
  const out = [];
  for (const key of grants) {
    const next = OLD_KEYS.includes(key) ? TYPE_KEY : key;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

async function readJsonIfExists(ctx, rel) {
  if (!(await ctx.fileExists(rel))) return null;
  return ctx.readJson(rel);
}

/** Install the engines, remove `websearch`. Returns what the apps step needs. */
async function migrateInstallations(ctx, apps) {
  const integrations = await readJsonIfExists(ctx, INTEGRATIONS_FILE);
  const installed = Array.isArray(integrations?.installed) ? integrations.installed : [];
  const index = installed.findIndex(entry => entry?.id === OLD_INSTANCE_ID);
  if (index === -1) {
    ctx.log(`No "${OLD_INSTANCE_ID}" installation: no web search engine to install`);
    return { defaultEngine: null, readerOff: false };
  }
  const websearch = installed[index];
  const fresh = await isFreshInstall(ctx);
  const plan = planEngines(websearch, { apps, env: process.env, fresh });

  for (const engine of plan.engines) {
    if (installed.some(entry => entry?.id === engine.id)) {
      ctx.log(`Installation "${engine.id}" exists already; left as it is`);
      continue;
    }
    installed.push(engine);
    ctx.log(
      `Web search engine "${engine.id}" installed (${engine.definition}, ${engine.enabled ? 'enabled' : 'disabled'}): ${plan.reasons[engine.id]}`
    );
    if (engine.actions.disabled.includes('search')) {
      ctx.log(`"${engine.id}": search switched off, as it was on "${OLD_INSTANCE_ID}"`);
    }
  }
  for (const [id, reason] of Object.entries(plan.skipped)) {
    ctx.log(`Web search engine "${id}" not installed: ${reason}`);
  }
  if (plan.defaultEngine && !plan.engines.some(engine => engine.id === plan.defaultEngine)) {
    ctx.warn(
      `The default search engine "${plan.defaultEngine}" is not installed (${plan.skipped[plan.defaultEngine]}); apps that used it search natively only until it is installed`
    );
  }

  installed.splice(installed.indexOf(websearch), 1);
  integrations.installed = installed;
  await ctx.writeJson(INTEGRATIONS_FILE, integrations);
  ctx.log(`Installation "${OLD_INSTANCE_ID}" (${OLD_DEFINITION}) removed`);

  await relabelCredentials(ctx, plan.engines);
  return plan;
}

/** The credentials V195 created now belong to an engine: say so in their description. */
async function relabelCredentials(ctx, engines) {
  const refs = new Map(
    engines
      .filter(engine => engine.values[API_KEY_FIELD])
      .map(engine => [engine.values[API_KEY_FIELD], engine.id])
  );
  if (refs.size === 0) return;
  const store = await readJsonIfExists(ctx, CREDENTIALS_FILE);
  if (!store?.credentials || typeof store.credentials !== 'object') return;
  let changed = false;
  for (const [ref, engineId] of refs) {
    const credential = store.credentials[ref];
    if (credential?.description !== V195_CREDENTIAL_DESCRIPTION) continue;
    credential.description = `API key of the web search engine "${engineId}"`;
    changed = true;
  }
  if (changed) await ctx.writeJson(CREDENTIALS_FILE, store);
}

/** A page reader `websearch` had switched off stays off, through a tool file. */
async function keepReaderOff(ctx) {
  if (await ctx.fileExists(READER_TOOL_FILE)) {
    ctx.log(`${READER_TOOL_FILE} exists already; the page reader follows it`);
    return;
  }
  let reader;
  try {
    reader = await ctx.readDefaultJson(READER_TOOL_FILE);
  } catch {
    ctx.warn(
      `The page reader was switched off on "${OLD_INSTANCE_ID}", but its shipped definition could not be read; switch it off under Admin → Tools`
    );
    return;
  }
  await ctx.writeJson(READER_TOOL_FILE, { ...reader, enabled: false });
  ctx.log(`${READER_TOOL_FILE} written with enabled: false: the page reader stays off`);
}

async function migrateGroups(ctx) {
  const file = await readJsonIfExists(ctx, GROUPS_FILE);
  const groups = file?.groups && typeof file.groups === 'object' ? file.groups : null;
  if (!groups) return;
  let changed = false;
  for (const [id, group] of Object.entries(groups)) {
    const next = migrateGrants(group?.permissions?.integrations);
    if (!next) continue;
    group.permissions.integrations = next;
    changed = true;
    ctx.log(`Group "${id}": the grant of "${OLD_INSTANCE_ID}" became "${TYPE_KEY}"`);
  }
  if (changed) await ctx.writeJson(GROUPS_FILE, file);
}

async function readApps(ctx) {
  const apps = [];
  for (const file of await ctx.listFiles('apps', '*.json')) {
    try {
      apps.push({ rel: `apps/${file}`, app: await ctx.readJson(`apps/${file}`) });
    } catch (error) {
      ctx.warn(`apps/${file} could not be read and is left as it is: ${error.message}`);
    }
  }
  return apps;
}

export async function up(ctx) {
  const apps = await readApps(ctx);
  const plan = await migrateInstallations(
    ctx,
    apps.map(entry => entry.app)
  );
  if (plan.readerOff) await keepReaderOff(ctx);
  await migrateGroups(ctx);

  for (const { rel, app } of apps) {
    const { app: next, changes } = migrateApp(app, plan.defaultEngine);
    if (!changes.length) continue;
    await ctx.writeJson(rel, next);
    ctx.log(`${rel}: ${changes.join('; ')}`);
  }
}
