// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connector of the `entra` installation (`com.intrafind/entra-directory`):
 * the Microsoft Entra ID people tools of `tools/entraPeopleSearch.js` under
 * their old ids (`entraPeopleSearch_findUser`, …), run with the app
 * registration's client credentials the installation holds.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as entraTool from '../../../../../../tools/entraPeopleSearch.js';
import entraService from '../../../../EntraService.js';
import { entraConfigFromInstance } from '../../../../entraConfig.js';

const PARAMETERS = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'parameters.json'), 'utf8')
);

function action(name) {
  return {
    parameters: PARAMETERS[name],
    run: args => entraTool[name](args)
  };
}

const TEST_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The installation test: settings present, a client-credentials token from
 * the tenant, one Graph call that needs User.Read.All.
 */
async function test({ instance, values }) {
  const cfg = entraConfigFromInstance({ ...instance, values, enabled: true });
  const steps = [];
  const missing = ['tenantId', 'clientId', 'clientSecret'].filter(key => !cfg[key]);
  steps.push({
    id: 'settings',
    label: 'App registration',
    status: missing.length ? 'fail' : 'ok',
    message: missing.length
      ? `Missing: ${missing.join(', ')} (set the field or the AZURE_* environment variable)`
      : `Tenant ${cfg.tenantId}, client ${cfg.clientId.slice(0, 8)}…${cfg.clientSecretRef ? '' : ' (secret from AZURE_CLIENT_SECRET)'}`
  });
  if (missing.length) return steps;
  const started = Date.now();
  let token;
  try {
    token = await withTimeout(entraService._getAccessToken(cfg), TEST_TIMEOUT_MS);
    steps.push({
      id: 'token',
      label: 'Client credentials',
      status: 'ok',
      message: `Token acquired in ${Date.now() - started} ms`
    });
  } catch (error) {
    steps.push({
      id: 'token',
      label: 'Client credentials',
      status: 'fail',
      message: error.message,
      hints: [
        'Check tenant id, client id and client secret in the Azure portal (App registrations → Certificates & secrets)',
        'Check the outbound proxy and firewall rules for login.microsoftonline.com and graph.microsoft.com'
      ]
    });
    return steps;
  }
  try {
    const result = await withTimeout(
      entraService._makeGraphRequest('/users?$top=1&$select=id,displayName', { token }),
      TEST_TIMEOUT_MS
    );
    const ok = Array.isArray(result?.value);
    steps.push({
      id: 'graph',
      label: 'Microsoft Graph',
      status: ok ? 'ok' : 'fail',
      message: ok
        ? `Directory readable (${result.value.length ? `first user: ${result.value[0].displayName}` : 'no users returned'})`
        : 'Graph refused the users listing',
      hints: ok
        ? undefined
        : [
            'Grant the application permission User.Read.All (and GroupMember.Read.All for teams) and give admin consent'
          ]
    });
  } catch (error) {
    steps.push({ id: 'graph', label: 'Microsoft Graph', status: 'fail', message: error.message });
  }
  return steps;
}

const connector = {
  id: 'entra',
  actions: {
    findUser: action('findUser'),
    getAllUserDetails: action('getAllUserDetails'),
    getUserManager: action('getUserManager'),
    getUserGroups: action('getUserGroups'),
    getTeamMembers: action('getTeamMembers'),
    getUserPhotoBase64: action('getUserPhotoBase64')
  },
  test,
  invalidate() {
    entraService.resetConfig();
  },
  onChanged() {
    entraService.resetConfig();
  }
};

export default connector;
