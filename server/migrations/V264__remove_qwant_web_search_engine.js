// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V264 — remove the Qwant web search engine
 *
 * Qwant is no longer a web search engine of iHub: the shipped definition
 * `com.intrafind/qwant-search`, its search script and its provider are gone.
 * Qwant blocks most requests from data-centre IP addresses, so it rarely
 * answered. Brave Search and Staan are the shipped engines.
 *
 * What this migration changes:
 *
 * - **The installation.** Every installation of `com.intrafind/qwant-search`
 *   (shipped as `qwant`) is removed from `config/integrations.json`. Without
 *   its definition it could not be loaded anyway.
 * - **Apps** with `websearch.provider: "qwant"` are set to `auto`: the first
 *   engine the user may use (Brave, then Staan, then any third-party engine).
 *   An app binding of the installation (`integrations.qwant`) is removed, and
 *   `integrations` with it when nothing else is bound.
 * - **Groups.** Grants of `qwant` or `com.intrafind/qwant-search` in
 *   `permissions.integrations` are removed. The grant `type:web-search` (every
 *   engine) is not touched.
 *
 * Nothing is installed in its place: an install that used Qwant has to
 * install and configure Brave or Staan (Admin → Integrations); until then an
 * app uses the model's native search where the model has one.
 *
 * Idempotent: when nothing refers to Qwant any more, nothing is written. Missing
 * files are skipped. Self-contained: no application module is imported (see
 * `server/migrations/README.md`).
 */

export const version = '264';
export const description = 'remove_qwant_web_search_engine';

const INTEGRATIONS_FILE = 'config/integrations.json';
const GROUPS_FILE = 'config/groups.json';

/** The shipped definition of the engine. */
export const QWANT_DEFINITION = 'com.intrafind/qwant-search';
/** The id of the shipped installation. */
export const QWANT_INSTANCE_ID = 'qwant';
/** Grants and bindings that name the engine: its installation id and its definition id. */
const QWANT_KEYS = Object.freeze([QWANT_INSTANCE_ID, QWANT_DEFINITION]);

export async function precondition(ctx) {
  if (await ctx.fileExists(INTEGRATIONS_FILE)) return true;
  if (await ctx.fileExists(GROUPS_FILE)) return true;
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

/**
 * An app without its references to Qwant: `websearch.provider: "qwant"` becomes
 * `auto`, and a binding of the installation is removed.
 *
 * @param {object} app
 * @returns {{ app: object, changes: string[] }} `changes` empty when nothing changed
 */
export function migrateApp(app) {
  if (!app || typeof app !== 'object') return { app, changes: [] };
  const next = { ...app };
  const changes = [];

  if (next.websearch && typeof next.websearch === 'object' && next.websearch.provider === 'qwant') {
    next.websearch = { ...next.websearch, provider: 'auto' };
    changes.push('websearch.provider "qwant" → "auto"');
  }

  if (next.integrations && typeof next.integrations === 'object') {
    const stale = Object.keys(next.integrations).filter(key => QWANT_KEYS.includes(key));
    if (stale.length) {
      const integrations = { ...next.integrations };
      for (const key of stale) delete integrations[key];
      if (Object.keys(integrations).length) next.integrations = integrations;
      else delete next.integrations;
      changes.push(`integration binding(s) ${stale.join(', ')} removed`);
    }
  }

  return { app: changes.length ? next : app, changes };
}

/**
 * A group's `permissions.integrations` without the grants that name Qwant.
 *
 * @param {string[]} grants
 * @returns {string[]|null} the new list, or null when nothing changes
 */
export function migrateGrants(grants) {
  if (!Array.isArray(grants) || !grants.some(key => QWANT_KEYS.includes(key))) return null;
  return grants.filter(key => !QWANT_KEYS.includes(key));
}

async function removeInstallations(ctx) {
  if (!(await ctx.fileExists(INTEGRATIONS_FILE))) return;
  const file = await ctx.readJson(INTEGRATIONS_FILE);
  if (!Array.isArray(file?.installed)) return;
  const kept = file.installed.filter(entry => entry?.definition !== QWANT_DEFINITION);
  const removed = file.installed.length - kept.length;
  if (removed === 0) {
    ctx.log('No Qwant installation — nothing to remove');
    return;
  }
  file.installed = kept;
  await ctx.writeJson(INTEGRATIONS_FILE, file);
  ctx.log(`Removed ${removed} installation(s) of ${QWANT_DEFINITION}`);
}

async function migrateGroups(ctx) {
  if (!(await ctx.fileExists(GROUPS_FILE))) return;
  const file = await ctx.readJson(GROUPS_FILE);
  const groups = file?.groups && typeof file.groups === 'object' ? file.groups : null;
  if (!groups) return;
  let changed = false;
  for (const [id, group] of Object.entries(groups)) {
    const next = migrateGrants(group?.permissions?.integrations);
    if (!next) continue;
    group.permissions.integrations = next;
    changed = true;
    ctx.log(`Group "${id}": grant of Qwant removed`);
  }
  if (changed) await ctx.writeJson(GROUPS_FILE, file);
}

async function migrateApps(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  for (const file of files) {
    const rel = `apps/${file}`;
    let app;
    try {
      app = await ctx.readJson(rel);
    } catch (error) {
      ctx.warn(`${rel} could not be read and is left as it is: ${error.message}`);
      continue;
    }
    const { app: next, changes } = migrateApp(app);
    if (!changes.length) continue;
    await ctx.writeJson(rel, next);
    ctx.log(`${rel}: ${changes.join('; ')}`);
  }
}

export async function up(ctx) {
  await removeInstallations(ctx);
  await migrateGroups(ctx);
  await migrateApps(ctx);
}
