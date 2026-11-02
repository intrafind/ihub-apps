// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { makeAdminApiCall } from './adminApi';

/**
 * Admin API of the installed integrations (Admin → Integrations → Installed):
 * the catalog of definitions, installed instances, tests.
 * Server: `server/routes/admin/integrations.js`.
 */

const BASE = '/admin/integrations';
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body });
const definitionPath = id => `${BASE}/catalog/${encodeURIComponent(id)}`;
const instancePath = id => `${BASE}/installed/${encodeURIComponent(id)}`;

/** The catalog: every shipped or registry-installed definition. */
export const fetchIntegrationCatalog = async () => (await makeAdminApiCall(`${BASE}/catalog`)).data;

/** One definition with its install fields, auth modes and actions. */
export const fetchIntegrationDefinition = async definitionId =>
  (await makeAdminApiCall(definitionPath(definitionId))).data.definition;

/** Test an unsaved instance of a definition. */
export const testIntegrationDraft = async (definitionId, draft) =>
  (
    await makeAdminApiCall(`${definitionPath(definitionId)}/_test`, {
      method: 'POST',
      ...json(draft)
    })
  ).data.result;

/**
 * A Markdown companion file of a definition (a release's notes, its README),
 * served from the definition folder on this server.
 */
export const fetchIntegrationDefinitionFile = async (definitionId, path) => {
  const query = new URLSearchParams({ path });
  const response = await makeAdminApiCall(`${definitionPath(definitionId)}/_file?${query}`, {
    responseType: 'text'
  });
  return typeof response.data === 'string' ? response.data : String(response.data ?? '');
};

/** Installations whose definition has a newer compatible version in a marketplace catalog. */
export const fetchIntegrationUpdates = async () => (await makeAdminApiCall(`${BASE}/updates`)).data;

/** Re-read the definition folders from disk. */
export const reloadIntegrationCatalog = async () =>
  (await makeAdminApiCall(`${BASE}/catalog/_reload`, { method: 'POST', ...json({}) })).data;

/** Installed instances with their labels. */
export const fetchInstalledIntegrations = async () =>
  (await makeAdminApiCall(`${BASE}/installed`)).data;

/** One instance with its effective values, live actions and definition. */
export const fetchInstalledIntegration = async id =>
  (await makeAdminApiCall(instancePath(id))).data;

/** Install (create an instance). `payload.secrets` carries sensitive values. */
export const installIntegration = async payload =>
  (await makeAdminApiCall(`${BASE}/installed`, { method: 'POST', ...json(payload) })).data.instance;

export const updateInstalledIntegration = async (id, payload) =>
  (await makeAdminApiCall(instancePath(id), { method: 'PUT', ...json(payload) })).data.instance;

/**
 * Set the tool approval of an installation (#2945): `{ default?, actions? }`, or
 * null to remove it. Changes nothing else of the installation.
 */
export const setInstalledIntegrationApproval = async (id, approval) =>
  (
    await makeAdminApiCall(`${instancePath(id)}/approval`, {
      method: 'PUT',
      ...json({ approval })
    })
  ).data.instance;

/**
 * Mark actions of an installation as reviewed (#2916): their current
 * fingerprints become the accepted ones. `actions` null marks every action.
 * Returns `{ instance, reviewed }`.
 */
export const markInstalledIntegrationActionsReviewed = async (id, actions = null) => {
  const { data } = await makeAdminApiCall(`${instancePath(id)}/actions/review`, {
    method: 'POST',
    ...json(Array.isArray(actions) ? { actions } : {})
  });
  return { instance: data.instance, reviewed: data.reviewed || [] };
};

/** The path of one action of an installation. */
const actionPath = (id, action) => `${instancePath(id)}/actions/${encodeURIComponent(action)}`;

/**
 * The detail of one action (#2974): what the model sees, side effect, data
 * flow and approval with their sources, guidance, examples, bindings, usage
 * and the connections a test can run with.
 */
export const fetchIntegrationAction = async (id, action) =>
  (await makeAdminApiCall(actionPath(id, action))).data.detail;

/**
 * Change the admin override of one action: `{ description?, guidance?,
 * examples?, sideEffect?, dataFlow? }`; null removes a part. Returns
 * `{ override, detail }`.
 */
export const saveIntegrationActionOverride = async (id, action, patch) => {
  const { data } = await makeAdminApiCall(actionPath(id, action), {
    method: 'PUT',
    ...json(patch)
  });
  return { override: data.override, detail: data.detail };
};

/**
 * Run one action without a model: `{ args, connection, confirm }`. Returns
 * the test result; a refused test (e.g. 409 `CONFIRMATION_REQUIRED`) throws
 * with `err.response.data.code`.
 */
export const testIntegrationAction = async (id, action, { args, connection, confirm }) =>
  (
    await makeAdminApiCall(`${actionPath(id, action)}/_test`, {
      method: 'POST',
      ...json({ args, connection, confirm: confirm === true })
    })
  ).data.result;

/** Set (or with null remove) the installation's own model instructions. */
export const saveIntegrationInstructions = async (id, instructions) =>
  (
    await makeAdminApiCall(`${instancePath(id)}/instructions`, {
      method: 'PUT',
      ...json({ instructions })
    })
  ).data.instance;

export const deleteInstalledIntegration = async id => {
  await makeAdminApiCall(instancePath(id), { method: 'DELETE' });
};

export const setInstalledIntegrationEnabled = async (id, enabled) =>
  (
    await makeAdminApiCall(`${instancePath(id)}/${enabled ? '_enable' : '_disable'}`, {
      method: 'POST',
      ...json({})
    })
  ).data.instance;

/**
 * The example apps an installation offers (`GET …/installed/:id/example-apps`):
 * the definition's shipped ones, or one generated from the definition.
 *
 * @param {string} id - the installation id
 * @returns {Promise<{ templates: Array<{ key: string, source: 'definition'|'generated', templateId: string, name: string, description: string, icon: string|null, color: string|null, suggestedId: string }>, grantedToYou: boolean, enabled: boolean }>}
 */
export const fetchExampleApps = async id =>
  (await makeAdminApiCall(`${instancePath(id)}/example-apps`)).data;

/**
 * Create an example app bound to the installation
 * (`POST …/installed/:id/example-apps`).
 *
 * @param {string} id - the installation id
 * @param {{ template: string, appId?: string, enabled?: boolean }} body
 * @returns {Promise<Object>} the created app
 */
export const createExampleApp = async (id, body) =>
  (await makeAdminApiCall(`${instancePath(id)}/example-apps`, { method: 'POST', ...json(body) }))
    .data.app;

/** Test a saved instance (optionally with an edited, unsaved body). */
export const testInstalledIntegration = async (id, draft = {}) =>
  (await makeAdminApiCall(`${instancePath(id)}/_test`, { method: 'POST', ...json(draft) })).data
    .result;

/**
 * Run (or re-run) the definition migration of an installation
 * (`POST …/installed/:id/_migrate`).
 *
 * @param {string} id - the installation id
 * @returns {Promise<{ success: boolean, result: 'migrated'|'stamped'|'current', logEntry: Object|null, instance: Object }>}
 * @throws the request error; `response.data` carries `{ code, reason, details, logEntry?, instance? }`
 */
export const migrateInstalledIntegration = async id =>
  (await makeAdminApiCall(`${instancePath(id)}/_migrate`, { method: 'POST', ...json({}) })).data;

/**
 * Restore a backup of an installation whose migration failed or that needs a
 * review (`POST …/installed/:id/_restore`).
 *
 * @param {string} id - the installation id
 * @param {string} [backup] - a backup id from `migration.backups`; the server's default without one
 * @returns {Promise<{ success: boolean, backup: Object, logEntry: Object, instance: Object }>}
 */
export const restoreInstalledIntegration = async (id, backup) =>
  (
    await makeAdminApiCall(`${instancePath(id)}/_restore`, {
      method: 'POST',
      ...json(backup ? { backup } : {})
    })
  ).data;

/**
 * Adopt the loaded definition version for an installation that needs a
 * review (`POST …/installed/:id/_adopt`).
 *
 * @param {string} id - the installation id
 * @returns {Promise<{ success: boolean, logEntry: Object, instance: Object }>}
 */
export const adoptInstalledIntegration = async id =>
  (await makeAdminApiCall(`${instancePath(id)}/_adopt`, { method: 'POST', ...json({}) })).data;

/** Users who connected their own account to an installation that signs every user in. */
export const fetchIntegrationConnections = async id =>
  (await makeAdminApiCall(`${instancePath(id)}/connections`)).data.connections || [];

/** Disconnect one user: revoke where possible, delete the stored tokens. */
export const disconnectIntegrationUser = async (id, userId) =>
  (
    await makeAdminApiCall(`${instancePath(id)}/connections/${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    })
  ).data;

/** Forget iHub's OAuth client registration at the authorization server. */
export const resetIntegrationRegistration = async id =>
  (
    await makeAdminApiCall(`${instancePath(id)}/registration/_reset`, {
      method: 'POST',
      ...json({})
    })
  ).data;

/**
 * What the dedicated People directory (LDAP), LDAP browser and Entra ID
 * editors need besides the installation: the search presets with their
 * mappings, the person fields, the defaults and upper bounds of the limits,
 * the LDAP sign-in providers a directory can reuse (without secrets) and
 * which `AZURE_*` environment variables the server has (set or not, never the
 * value). Server: `server/routes/admin/peopleDirectoryEditor.js`.
 */
export const fetchPeopleDirectoryEditorContext = async () =>
  (await makeAdminApiCall(`${BASE}/people-directories/editor-context`)).data;
