// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { NoSuchObjectError } from 'ldapts';
import logger from '../../utils/logger.js';
import { logAudit } from '../AuditLogService.js';
import { DiagnosticsReport, STATUS } from '../integrations/integrationDiagnostics.js';
import { DirectoryConnectionError, openDirectoryConnection } from './connection.js';
import { boundedSearch } from './LdapDirectory.js';
import {
  MAX_CHILDREN,
  MAX_FILTER_LENGTH,
  browseChildren,
  browseRead,
  browseSearch
} from './LdapBrowser.js';
import { ToolArgumentError, timeLimitSeconds } from './query.js';
import { findBrowser, mayUseBrowser, resolveBrowser } from './LdapBrowserService.js';
import { MODEL_ERROR_MESSAGES, inDirectoryQueue, resultCount } from './peopleDirectoryRunner.js';
import { hostOf } from './PeopleDirectoryService.js';

/**
 * Running the admin LDAP browser's tools (`com.intrafind/ldap-browser`), and
 * its admin connection test. Loaded when a browse tool runs or an admin tests
 * a browser, not with every tool listing.
 *
 * A browser reuses the connection of the directory it names, so its calls go
 * through that directory's throttle queue (`peopleDirectory:<directoryId>`).
 * Every call — answered, refused for a bad argument, or refused for lack of
 * access — writes an audit record (resource `ldapBrowse`, the browser
 * installation id as resource id).
 */

const COMPONENT = 'LdapBrowser';

const OPERATIONS = {
  browse_search: browseSearch,
  browse_read: browseRead,
  browse_children: browseChildren
};

/** Most requested attribute names written to one audit record. */
const MAX_AUDITED_ATTRIBUTES = 50;

/**
 * A model-supplied argument as the audit record holds it: text cut at the
 * filter limit, lists cut at {@link MAX_AUDITED_ATTRIBUTES}. Refused calls are
 * audited before their arguments are checked, so nothing here is trusted.
 */
function auditable(value) {
  if (Array.isArray(value)) return value.slice(0, MAX_AUDITED_ATTRIBUTES).map(auditable);
  if (typeof value === 'string') return value.slice(0, MAX_FILTER_LENGTH);
  return typeof value === 'number' || typeof value === 'boolean' || value === null
    ? value
    : String(value).slice(0, MAX_FILTER_LENGTH);
}

/**
 * The audit record of an LDAP browser call: who asked what of which browser
 * (and directory), and how many entries came back — never the values.
 * Filters are written as sent (up to the filter limit); they can hold names
 * or e-mail addresses.
 *
 * @param {Object|null} user
 * @param {string} browserId
 * @param {string|null} directoryId
 * @param {string} action
 * @param {Object} params - The tool call's arguments
 * @param {Object} outcome - `{ entries, truncated }` or `{ error }`
 */
function auditBrowse(user, browserId, directoryId, action, params, outcome) {
  const asked = { tool: action };
  if (directoryId) asked.directory = directoryId;
  for (const key of ['filter', 'base', 'scope', 'dn', 'attributes']) {
    if (params[key] !== undefined) asked[key] = auditable(params[key]);
  }
  logAudit({
    action: 'read',
    resource: 'ldapBrowse',
    resourceId: browserId,
    summary: JSON.stringify({ ...asked, ...outcome }),
    result: outcome.error ? 'failure' : 'success',
    source: 'web',
    actor: user || { id: 'unknown' }
  });
}

/**
 * Run a browse tool for the user in the call's context.
 *
 * @param {Object} tool - Tool definition (with `_ldapBrowser`)
 * @param {Object} params - Tool arguments plus `user`, `chatId`, `appConfig`
 * @param {Object} [deps] - `{ connect }` for tests
 * @returns {Promise<Object>} The result, or `{ directory, error }` the model can act on
 * @throws {Error} When the user may not use the browser
 */
export async function runLdapBrowserTool(tool, params = {}, deps = {}) {
  const { id: browserId, action } = tool._ldapBrowser || {};
  const operation = OPERATIONS[action];
  const raw = findBrowser(browserId);
  // The last guard: the listing already left the tool out for this user.
  if (!operation || !raw || raw.enabled === false || !mayUseBrowser(params.user, browserId)) {
    logger.warn('LDAP browser tool refused', {
      component: COMPONENT,
      browserId,
      action,
      userId: params.user?.id || null
    });
    auditBrowse(params.user, browserId, raw?.directory || null, action, params, {
      error: 'access_denied'
    });
    throw new Error(`Tool ${tool.id} is not available`);
  }

  const browser = resolveBrowser(raw);
  if (browser.problems.length > 0) {
    auditBrowse(params.user, browserId, browser.directoryId, action, params, {
      error: 'configuration'
    });
    return {
      directory: browser.directoryId,
      error: { code: 'configuration', message: MODEL_ERROR_MESSAGES.default }
    };
  }

  const startedAt = Date.now();
  try {
    const result = await inDirectoryQueue(browser.directory, () =>
      operation(browser, params, deps)
    );
    logger.info('LDAP browser call', {
      component: COMPONENT,
      browserId,
      directoryId: browser.directoryId,
      action,
      userId: params.user?.id || null,
      resultCount: resultCount(result),
      durationMs: Date.now() - startedAt
    });
    auditBrowse(params.user, browserId, browser.directoryId, action, params, {
      entries: resultCount(result),
      truncated: result?.truncated === true,
      ...(result?.error && { error: result.error.code })
    });
    return result;
  } catch (error) {
    auditBrowse(params.user, browserId, browser.directoryId, action, params, {
      error: error?.code || 'directory_error'
    });
    if (error instanceof ToolArgumentError) {
      return {
        directory: browser.directoryId,
        error: { code: error.code, message: error.message }
      };
    }
    logger.warn('LDAP browser call failed', {
      component: COMPONENT,
      browserId,
      directoryId: browser.directoryId,
      action,
      userId: params.user?.id || null,
      code: error?.code,
      step: error?.step,
      error: error?.message,
      durationMs: Date.now() - startedAt
    });
    const code = error instanceof DirectoryConnectionError ? error.code : 'directory_error';
    return {
      directory: browser.directoryId,
      error: { code, message: MODEL_ERROR_MESSAGES[code] || MODEL_ERROR_MESSAGES.default }
    };
  }
}

/** How many children the admin test lists under the browse base. */
const TEST_CHILDREN = 20;

/**
 * The admin connection test of a browser: resolve (the directory it reuses,
 * its base and bind), address check, connect, StartTLS, bind with the
 * browser's account, and a look at the browse base (its direct children),
 * reported step by step. Changes nothing and writes no audit record (the
 * admin reads no entry values).
 *
 * @param {Object} raw - Saved or inline browser entry (`browserFromInstance`)
 * @param {Object} [options]
 * @param {Object} [options.deps] - `{ connectOptions, connect }` for tests
 * @param {boolean} [options.unsaved] - A draft: queued by host, so tests of
 *   different new entries do not wait on each other
 * @returns {Promise<{success: boolean, message: string, summary: Object, steps: Object[]}>}
 */
export async function testBrowser(raw, { deps = {}, unsaved = false } = {}) {
  const report = new DiagnosticsReport();
  const resolved = resolveBrowser(raw);
  const finish = (success, message) => ({
    success,
    message,
    summary: report.summary(),
    steps: report.steps
  });

  const hints = [...resolved.problems, ...resolved.warnings];
  if (resolved.directory && !resolved.directoryEnabled) {
    hints.push(
      `The directory "${resolved.directoryId}" is disabled: the browser offers its tools only while the directory is enabled.`
    );
  }
  report.add({
    id: 'configuration',
    label: 'Effective configuration',
    status: resolved.problems.length > 0 ? STATUS.FAIL : hints.length > 0 ? STATUS.WARN : STATUS.OK,
    message:
      resolved.problems.length > 0
        ? resolved.problems.join(' ')
        : `${resolved.directory.url} (directory "${resolved.directoryId}"), confined to ${resolved.base}`,
    details: {
      directory: resolved.directoryId || null,
      url: resolved.directory?.url || null,
      transport: resolved.transport,
      base: resolved.base || null,
      bind: resolved.ownBind
        ? `own account ${resolved.bind?.mode === 'service' ? resolved.bind.dn : resolved.bind?.mode}`
        : 'the directory bind',
      maxResults: resolved.maxResults,
      denyAttributes: resolved.denyAttributes
    },
    hints
  });
  if (resolved.problems.length > 0) {
    return finish(false, 'The LDAP browser configuration is incomplete.');
  }

  const labels = {
    network: 'Address check (SSRF)',
    connect: 'Connect',
    starttls: 'StartTLS',
    bind: 'Bind'
  };
  const connection = { ...resolved.directory, bind: resolved.bind };
  const queueId = unsaved
    ? `test:${hostOf(resolved.directory.url) || 'unknown'}`
    : resolved.directory.id;
  return inDirectoryQueue(
    resolved.directory,
    async () => {
      let client;
      try {
        const connect = deps.connect || openDirectoryConnection;
        ({ client } = await connect(connection, {
          ...deps.connectOptions,
          onStep: step =>
            report.add({ label: labels[step.id] || step.id, status: STATUS.OK, ...step })
        }));
      } catch (error) {
        report.add({
          id: error?.step && error.step !== 'configuration' ? error.step : 'connect',
          label: labels[error?.step] || 'Connect',
          status: STATUS.FAIL,
          message: error?.message || String(error),
          details: error?.details,
          hints: error?.hints
        });
        return finish(false, error?.message || 'The directory could not be reached.');
      }

      const startedAt = Date.now();
      try {
        const { entries, truncated } = await boundedSearch(client, resolved.base, {
          scope: 'one',
          filter: '(objectClass=*)',
          attributes: ['objectClass'],
          sizeLimit: Math.min(TEST_CHILDREN, MAX_CHILDREN),
          timeLimit: timeLimitSeconds(resolved.directory.timeoutMs)
        });
        report.add({
          id: 'base',
          label: 'Browse base',
          status: STATUS.OK,
          message: `${entries.length}${truncated ? '+' : ''} ${entries.length === 1 ? 'entry' : 'entries'} directly under ${resolved.base}`,
          details: { base: resolved.base, children: entries.map(entry => entry.dn) },
          durationMs: Date.now() - startedAt
        });
        return finish(true, 'The LDAP browser can read its base.');
      } catch (error) {
        const missing = error instanceof NoSuchObjectError;
        report.add({
          id: 'base',
          label: 'Browse base',
          status: STATUS.FAIL,
          message: missing
            ? `No entry at ${resolved.base}, or the account may not read it.`
            : error?.message || String(error),
          hints: missing
            ? ["Check the browse base, or the base DN of the directory, and the account's rights."]
            : [],
          durationMs: Date.now() - startedAt
        });
        return finish(false, `The browse base could not be read: ${error?.message || error}`);
      } finally {
        try {
          await client.unbind();
        } catch {
          // gone either way
        }
      }
    },
    queueId
  );
}
