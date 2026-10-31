// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Built-in connector of the `jira` installation (`com.intrafind/jira`): the
 * six Jira Cloud tools of `tools/jira.js` under their old ids
 * (`jira_searchTickets`, …), every call as the signed-in user with the
 * Atlassian account they connected through `/api/integrations/jira/auth`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as jiraTool from '../../../../../../tools/jira.js';
import JiraService from '../../../../JiraService.js';
import credentialService from '../../../../../CredentialService.js';
import { httpFetch } from '../../../../../../utils/httpConfig.js';
import {
  JIRA_CALLBACK_PATH,
  isJiraConfigured,
  jiraConfigFromInstance,
  listJiraConnections,
  resolveJiraRedirectUri
} from '../../../../jiraConfig.js';
import {
  getJiraConnectionCount,
  refreshJiraConnectionCount,
  setJiraConnectionCount
} from '../../../../jiraConnectionCount.js';

const PARAMETERS = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'parameters.json'), 'utf8')
);

/** The tool call as `tools/jira.js` expects it: the arguments plus the user. */
function action(name) {
  return {
    parameters: PARAMETERS[name],
    run: (args, ctx) => jiraTool[name]({ ...args, user: ctx.user ?? ctx.params?.user })
  };
}

const TEST_TIMEOUT_MS = 10000;

/**
 * The redirect URI step of the test: a configured value must be an http(s)
 * URL ending in the callback path; an empty one is derived from each request,
 * and the admin's own request shows what that comes to.
 * @param {{ redirectUri: string }} cfg
 * @param {import('express').Request} [req] - The admin's request, for the derived example
 */
export function redirectUriStep(cfg, req) {
  const step = { id: 'redirect', label: 'Redirect URI' };
  if (cfg.redirectUri) {
    let ok = false;
    try {
      const url = new URL(cfg.redirectUri);
      ok = /^https?:$/.test(url.protocol) && url.pathname.endsWith(JIRA_CALLBACK_PATH);
    } catch {
      ok = false;
    }
    return {
      ...step,
      status: ok ? 'ok' : 'warn',
      message: ok
        ? cfg.redirectUri
        : `${cfg.redirectUri} should end in ${JIRA_CALLBACK_PATH} and be registered in the Atlassian app`
    };
  }
  let derived = null;
  try {
    derived = resolveJiraRedirectUri(req, cfg);
  } catch {
    derived = null;
  }
  return {
    ...step,
    status: 'ok',
    message: derived
      ? `Empty: derived from the request, here ${derived}; register that URL in the Atlassian app`
      : `Empty: derived from each request as <scheme>://<host><base path>${JIRA_CALLBACK_PATH}; register that URL in the Atlassian app`
  };
}

/**
 * The installation test: client id and secret present, the redirect URI
 * well-formed or derivable, Atlassian's authorization server reachable, and
 * how many users are connected. The OAuth flow itself needs a browser, so it
 * is not run.
 */
async function test({ instance, values, user, req }) {
  const cfg = jiraConfigFromInstance({ ...instance, values, enabled: true });
  const steps = [];
  const secret = cfg.clientSecretRef ? credentialService.tryResolveSecret(cfg.clientSecretRef) : '';
  steps.push({
    id: 'client',
    label: 'OAuth client',
    status: cfg.clientId && secret ? 'ok' : 'fail',
    message: !cfg.clientId
      ? 'No client id'
      : !cfg.clientSecretRef
        ? 'No client secret credential'
        : !secret
          ? `Credential "${cfg.clientSecretRef}" has no value or does not exist`
          : `Client ${cfg.clientId.slice(0, 6)}… with secret`
  });
  steps.push(redirectUriStep(cfg, req));
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const response = await httpFetch(JiraService.authUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal
      });
      steps.push({
        id: 'reachability',
        label: 'auth.atlassian.com',
        status: response.status < 500 ? 'ok' : 'warn',
        message: `HTTP ${response.status} in ${Date.now() - started} ms`
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    steps.push({
      id: 'reachability',
      label: 'auth.atlassian.com',
      status: 'fail',
      message:
        error.name === 'AbortError' ? `No answer within ${TEST_TIMEOUT_MS} ms` : error.message,
      hints: [
        'Check the outbound proxy and firewall rules for auth.atlassian.com and api.atlassian.com'
      ]
    });
  }
  const connections = await listJiraConnections();
  setJiraConnectionCount(connections.length);
  const mine = user?.id ? connections.some(c => c.userId === user.id) : false;
  steps.push({
    id: 'connections',
    label: 'Connected users',
    status: 'ok',
    message: `${connections.length} user(s) connected${user?.id ? (mine ? ', including you' : ', not you yet') : ''}`
  });
  return steps;
}

const connector = {
  id: 'jira',
  actions: {
    searchTickets: action('searchTickets'),
    getTicket: action('getTicket'),
    addComment: action('addComment'),
    getTransitions: action('getTransitions'),
    transitionTicket: action('transitionTicket'),
    getAttachment: action('getAttachment')
  },
  test,
  /**
   * For the installed list: per-user sign-in, how many users connected. The
   * count is adjusted as users connect and disconnect on this worker and
   * re-counted from disk in the background at most every 30 s, so the other
   * cluster workers converge too (see jiraConnectionCount.js).
   */
  status(instance) {
    refreshJiraConnectionCount().catch(() => {});
    return {
      connected: isJiraConfigured(jiraConfigFromInstance(instance)),
      perUser: true,
      userConnections: getJiraConnectionCount()
    };
  },
  async listConnections() {
    const connections = await listJiraConnections();
    setJiraConnectionCount(connections.length);
    return connections;
  },
  async disconnectUser(_instance, userId) {
    const removed = await JiraService.deleteUserTokens(userId);
    return { removed: Boolean(removed) };
  },
  invalidate() {},
  onChanged() {}
};

// Seed the count for the status pill without a disk read per request.
refreshJiraConnectionCount({ force: true }).catch(() => {});

export default connector;
