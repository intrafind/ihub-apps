// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V201 — the shipped iFinder app gets its iFinder actions back
 *
 * V192 read an app that binds `integrations.ifinder` but lists no `iFinder*`
 * tool as an app that bound iFinder for its scope settings only, and set
 * `actions: []` on the binding: no tools. That is right for an app migrated
 * from 5.6.4 that never had the iFinder tools, but the shipped apps are
 * already written in the new form (`integrations.ifinder` without `actions`,
 * which binds every action), and migrations also run over the defaults a fresh
 * install copies. On a fresh install the shipped `ifinder-search` app
 * therefore lost all seven iFinder tools, and the model answered that it had
 * no access to them although the integration was enabled.
 *
 * Repair: an app whose `integrations.ifinder.actions` is an empty list while
 * the shipped app of the same file binds iFinder without an `actions` list
 * gets the list removed again, so it binds every action as shipped. Apps iHub
 * does not ship, and shipped apps whose default binding names its actions, are
 * left alone: there an empty list may be the admin's choice (scope settings
 * only).
 */

export const version = '201';
export const description = 'restore_ifinder_actions_on_shipped_apps';

const INSTANCE_ID = 'ifinder';

export async function precondition(ctx) {
  return (await ctx.listFiles('apps', '*.json')).length > 0;
}

/**
 * Whether a shipped app binds iFinder with every action (a binding without an
 * `actions` list).
 * @param {object|null} shippedApp
 */
export function shipsAllIFinderActions(shippedApp) {
  const binding = shippedApp?.integrations?.[INSTANCE_ID];
  return Boolean(binding) && typeof binding === 'object' && !Object.hasOwn(binding, 'actions');
}

/** Whether the app binds iFinder with an empty `actions` list. */
export function hasEmptiedIFinderBinding(app) {
  const actions = app?.integrations?.[INSTANCE_ID]?.actions;
  return Array.isArray(actions) && actions.length === 0;
}

/**
 * The app with the empty `actions` list of its iFinder binding removed, or
 * null when nothing changes.
 * @param {object} app - the app in contents
 * @param {object|null} shippedApp - the shipped app of the same file, if any
 */
export function restoreIFinderBinding(app, shippedApp) {
  if (!hasEmptiedIFinderBinding(app) || !shipsAllIFinderActions(shippedApp)) return null;
  const binding = { ...app.integrations[INSTANCE_ID] };
  delete binding.actions;
  return { ...app, integrations: { ...app.integrations, [INSTANCE_ID]: binding } };
}

async function readShippedApp(ctx, file) {
  try {
    return await ctx.readDefaultJson(`apps/${file}`);
  } catch {
    return null; // not a shipped app
  }
}

export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  const apps = await Promise.all(files.map(file => ctx.readJson(`apps/${file}`)));
  let restored = 0;
  // Sequential on purpose: one log line and one write per app, in file order.
  for (const [index, file] of files.entries()) {
    const app = apps[index];
    if (!hasEmptiedIFinderBinding(app)) continue;
    const next = restoreIFinderBinding(app, await readShippedApp(ctx, file));
    if (!next) continue;
    await ctx.writeJson(`apps/${file}`, next);
    restored++;
    ctx.log(`apps/${file}: integrations.ifinder binds every iFinder action again, as shipped`);
  }
  if (restored === 0) ctx.log('No shipped app with an emptied iFinder binding');
}
