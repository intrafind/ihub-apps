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

/** Test a saved instance (optionally with an edited, unsaved body). */
export const testInstalledIntegration = async (id, draft = {}) =>
  (await makeAdminApiCall(`${instancePath(id)}/_test`, { method: 'POST', ...json(draft) })).data
    .result;

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
