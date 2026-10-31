// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V195 — web search becomes the built-in installation `websearch`
 *
 * The search engines' API keys leave `config/providers.json` (the entries of
 * category `websearch`) for the credential store, referenced by the new
 * installation `websearch` (definition `com.intrafind/web-search`), which
 * also holds the default engine. The shipped tool files `braveSearch.json`,
 * `staanSearch.json`, `qwantSearch.json` and `read_url.json` are removed: the
 * installation owns these tools and their ids stay the same. Apps keep their
 * `websearch` settings; the installation is a requirement of every app that
 * has web search on.
 *
 * An app that got web search by listing a search tool in `tools` (the
 * `deep-researcher` example's `"braveSearch"`) rather than through
 * `websearch.enabled` keeps it: the reference becomes `websearch: { enabled,
 * enabledByDefault, provider }` with the engine it named. A `read_url`
 * reference stays in `tools`: the tool loader serves it from the installation.
 */

export const version = '195';
export const description = 'web_search_installed_integration';

const PROVIDERS_FILE = 'config/providers.json';
const INTEGRATIONS_FILE = 'config/integrations.json';
const CREDENTIALS_FILE = 'config/credentials.json';
const INSTANCE_ID = 'websearch';
const DEFINITION = 'com.intrafind/web-search';
const TOOL_FILES = ['braveSearch.json', 'staanSearch.json', 'qwantSearch.json', 'read_url.json'];
const SEARCH_TOOL_ENGINES = { braveSearch: 'brave', staanSearch: 'staan', qwantSearch: 'qwant' };
const KEYED_ENGINES = { brave: 'braveCredentialRef', staan: 'staanCredentialRef' };

export async function precondition(ctx) {
  if (await ctx.fileExists(PROVIDERS_FILE)) return true;
  for (const file of TOOL_FILES) if (await ctx.fileExists(`tools/${file}`)) return true;
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

function providersOf(raw) {
  if (Array.isArray(raw)) return { list: raw, wrap: list => list };
  if (raw && Array.isArray(raw.providers))
    return { list: raw.providers, wrap: list => ({ ...raw, providers: list }) };
  return { list: [], wrap: () => raw };
}

/**
 * The installation and the credentials the web search provider entries become.
 * @param {object[]} providers - `providers.json` entries
 * @param {object} [existingInstance]
 */
export function websearchFrom(providers, existingInstance) {
  const values = { ...(existingInstance?.values || {}) };
  if (!values.defaultProvider) values.defaultProvider = 'auto';
  const credentials = [];
  let enabled = existingInstance ? existingInstance.enabled !== false : true;
  for (const [engine, fieldKey] of Object.entries(KEYED_ENGINES)) {
    const entry = providers.find(p => p?.id === engine && p.category === 'websearch');
    if (!entry) continue;
    if (typeof entry.apiKey === 'string' && entry.apiKey && !values[fieldKey]) {
      const id = `integration-${INSTANCE_ID}-${engine}`;
      credentials.push({
        id,
        type: 'secret',
        name: `Web search: ${entry.name || engine} API key`,
        description: `Managed by the installed integration "${INSTANCE_ID}"`,
        // The provider key was already encrypted with the same key the
        // credential store uses, so it is carried over as it is.
        value: entry.apiKey
      });
      values[fieldKey] = id;
    }
  }
  const instance = {
    ...(existingInstance || {}),
    id: INSTANCE_ID,
    definition: DEFINITION,
    enabled,
    values,
    auth: existingInstance?.auth || { mode: 'none' },
    actions: existingInstance?.actions || { enabled: ['*'], disabled: [], overrides: {} },
    allowedGroups: existingInstance?.allowedGroups || []
  };
  return { instance, credentials };
}

/**
 * An app's `tools` without the search tool references, and the `websearch`
 * settings that replace them when the app had none.
 *
 * @param {object} app
 * @param {string} defaultProvider - The installation's default engine; among
 *   several referenced engines it wins, else the first listed does
 * @returns {{ app: object, engines: string[], provider: string|null }|null}
 *   null when the app references no search tool
 */
export function migrateAppSearchTools(app, defaultProvider = 'auto') {
  if (!Array.isArray(app?.tools)) return null;
  const engines = app.tools
    .filter(ref => SEARCH_TOOL_ENGINES[ref])
    .map(ref => SEARCH_TOOL_ENGINES[ref]);
  if (!engines.length) return null;
  const kept = app.tools.filter(ref => !SEARCH_TOOL_ENGINES[ref]);
  const next = { ...app, tools: kept };
  if (!kept.length) delete next.tools;
  let provider = null;
  if (app.websearch?.enabled !== true) {
    provider = engines.includes(defaultProvider) ? defaultProvider : engines[0];
    next.websearch = {
      ...(app.websearch && typeof app.websearch === 'object' ? app.websearch : {}),
      enabled: true,
      enabledByDefault: true,
      provider
    };
  }
  return { app: next, engines, provider };
}

export async function up(ctx) {
  const rawProviders = (await ctx.fileExists(PROVIDERS_FILE))
    ? await ctx.readJson(PROVIDERS_FILE)
    : null;
  const { list: providers, wrap } = providersOf(rawProviders);
  const websearchProviders = providers.filter(p => p?.category === 'websearch');

  const integrations = (await ctx.fileExists(INTEGRATIONS_FILE))
    ? (await ctx.readJson(INTEGRATIONS_FILE)) || {}
    : {};
  if (!Array.isArray(integrations.installed)) integrations.installed = [];
  if (!integrations.security) integrations.security = { blockPrivateIps: true, allowedHosts: [] };

  const index = integrations.installed.findIndex(inst => inst?.id === INSTANCE_ID);
  const { instance, credentials } = websearchFrom(
    websearchProviders,
    index >= 0 ? integrations.installed[index] : null
  );
  const now = new Date().toISOString();
  if (index >= 0) {
    integrations.installed[index] = { ...instance, updatedAt: now };
    ctx.log(`Installed integration "${INSTANCE_ID}" updated from the web search providers`);
  } else {
    integrations.installed.push({ ...instance, installedAt: now, updatedAt: now });
    ctx.log(`Installed integration "${INSTANCE_ID}" created (${DEFINITION})`);
  }
  await ctx.writeJson(INTEGRATIONS_FILE, integrations);

  if (credentials.length) {
    const store = (await ctx.fileExists(CREDENTIALS_FILE))
      ? (await ctx.readJson(CREDENTIALS_FILE)) || {}
      : {};
    if (!store.credentials) store.credentials = {};
    for (const credential of credentials) {
      if (store.credentials[credential.id]) continue;
      store.credentials[credential.id] = credential;
      ctx.log(`Credential "${credential.id}" created from the web search provider key`);
    }
    await ctx.writeJson(CREDENTIALS_FILE, store);
  }

  if (rawProviders && websearchProviders.length) {
    await ctx.writeJson(PROVIDERS_FILE, wrap(providers.filter(p => p?.category !== 'websearch')));
    ctx.log(`${websearchProviders.length} web search provider(s) removed from ${PROVIDERS_FILE}`);
  }

  for (const file of TOOL_FILES) {
    const rel = `tools/${file}`;
    if (await ctx.fileExists(rel)) {
      await ctx.deleteFile(rel);
      ctx.log(`${rel} removed: the web search installation owns the tool`);
    }
  }

  // Web search is configured in `app.websearch`. An app that had it only
  // through a search tool reference gets the equivalent settings, so it keeps
  // searching with the engine it named; `read_url` stays, the tool loader
  // serves it from the installation.
  const defaultProvider = instance.values?.defaultProvider || 'auto';
  for (const file of await ctx.listFiles('apps', '*.json')) {
    const rel = `apps/${file}`;
    const app = await ctx.readJson(rel);
    const migrated = migrateAppSearchTools(app, defaultProvider);
    if (!migrated) continue;
    await ctx.writeJson(rel, migrated.app);
    ctx.log(
      migrated.provider
        ? `${rel}: search tool reference(s) ${migrated.engines.join(', ')} replaced by websearch.enabled with provider "${migrated.provider}"`
        : `${rel}: search tool reference(s) ${migrated.engines.join(', ')} removed from tools (websearch already enabled)`
    );
  }
}
