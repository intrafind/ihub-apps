// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../../utils/logger.js';
import { throttledRun } from '../../requestThrottler.js';
import { logAudit } from '../AuditLogService.js';
import { DiagnosticsReport, STATUS } from '../integrations/integrationDiagnostics.js';
import { DirectoryConnectionError, openDirectoryConnection } from './connection.js';
import {
  getPerson,
  listUnits,
  prepareSearch,
  runSearch,
  searchPeople,
  searchResult
} from './LdapDirectory.js';
import { MAX_FILTER_LENGTH, browseChildren, browseRead, browseSearch } from './LdapBrowser.js';
import { mapEntryToPerson } from './mapping.js';
import { ToolArgumentError } from './query.js';
import {
  BROWSE_ACTIONS,
  findDirectory,
  hostOf,
  mayUseDirectoryTool,
  resolveDirectory
} from './PeopleDirectoryService.js';

/**
 * Running people directory tools, and the admin connection test. Loaded when a
 * directory tool runs or an admin tests a directory, not with every tool
 * listing.
 *
 * Every call of a directory — from any of its tools, and its admin test — goes
 * through one throttle queue, `peopleDirectory:<id>`, with the directory's
 * `concurrency` and `requestDelayMs`.
 */

const COMPONENT = 'PeopleDirectory';

/** What the model is told when a directory fails, without internal host names or addresses. */
const MODEL_ERROR_MESSAGES = {
  timeout:
    'The directory did not answer in time. Tell the user the directory is not reachable right now.',
  time_limit: 'The directory stopped the search because it took too long. Narrow the search.',
  bind_failed:
    'The directory refused access. Tell the user; an administrator can check the directory with its connection test.',
  default:
    'The directory is not available right now. Tell the user; an administrator can check the directory with its connection test.'
};

/**
 * Throttle queue of a directory: shared by all of its tools and its admin test.
 * @param {Object} resolved
 * @param {() => Promise<*>} fn
 * @param {string} [queueId] - Another queue, for an entry that is not saved yet
 */
function inDirectoryQueue(resolved, fn, queueId = resolved.id) {
  return throttledRun(`peopleDirectory:${queueId}`, fn, {
    concurrency: resolved.concurrency,
    delayMs: resolved.requestDelayMs
  });
}

const OPERATIONS = {
  search_people: searchPeople,
  get_person: getPerson,
  list_units: listUnits,
  browse_search: browseSearch,
  browse_read: browseRead,
  browse_children: browseChildren
};

/** How many entries, people or units a result holds, for the log. */
function resultCount(result) {
  for (const key of ['results', 'units', 'entries', 'children']) {
    if (Array.isArray(result?.[key])) return result[key].length;
  }
  return result?.error ? 0 : 1;
}

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
 * The audit record of an LDAP browser call: who asked what of which directory,
 * and how many entries came back — never the values. Filters are written as
 * sent (up to the filter limit); they can hold names or e-mail addresses.
 */
function auditBrowse(user, directoryId, action, params, outcome) {
  const asked = { tool: action };
  for (const key of ['filter', 'base', 'scope', 'dn', 'attributes']) {
    if (params[key] !== undefined) asked[key] = auditable(params[key]);
  }
  logAudit({
    action: 'read',
    resource: 'ldapBrowse',
    resourceId: directoryId,
    summary: JSON.stringify({ ...asked, ...outcome }),
    result: outcome.error ? 'failure' : 'success',
    source: 'web',
    actor: user || { id: 'unknown' }
  });
}

/**
 * Run a directory tool for the user in the call's context.
 *
 * @param {Object} tool - Tool definition (with `_peopleDirectory`)
 * @param {Object} params - Tool arguments plus `user`, `chatId`, `appConfig`
 * @param {Object} [deps] - `{ connect }` for tests
 * @returns {Promise<Object>} The result, or `{ directory, error }` the model can act on
 * @throws {Error} When the user may not use the directory
 */
export async function runPeopleDirectoryTool(tool, params = {}, deps = {}) {
  const { id: directoryId, action } = tool._peopleDirectory || {};
  const operation = OPERATIONS[action];
  const browse = BROWSE_ACTIONS.includes(action);
  const raw = findDirectory(directoryId);
  // The last guard: the listing already left the tool out for this user.
  if (
    !operation ||
    !raw ||
    raw.enabled === false ||
    !mayUseDirectoryTool(params.user, { id: directoryId, action })
  ) {
    logger.warn('People directory tool refused', {
      component: COMPONENT,
      directoryId,
      action,
      userId: params.user?.id || null
    });
    if (browse) auditBrowse(params.user, directoryId, action, params, { error: 'access_denied' });
    throw new Error(`Tool ${tool.id} is not available`);
  }

  const resolved = resolveDirectory(raw);
  if (
    resolved.problems.length > 0 ||
    (browse && (!resolved.browse || resolved.browse.problems.length > 0))
  ) {
    return {
      directory: directoryId,
      error: { code: 'configuration', message: MODEL_ERROR_MESSAGES.default }
    };
  }

  const startedAt = Date.now();
  try {
    const result = await inDirectoryQueue(resolved, () => operation(resolved, params, deps));
    logger.info(browse ? 'LDAP browser call' : 'People directory search', {
      component: COMPONENT,
      directoryId,
      action,
      userId: params.user?.id || null,
      resultCount: resultCount(result),
      durationMs: Date.now() - startedAt
    });
    if (browse) {
      auditBrowse(params.user, directoryId, action, params, {
        entries: resultCount(result),
        truncated: result?.truncated === true,
        ...(result?.error && { error: result.error.code })
      });
    }
    // The query is personal data: only at debug level.
    logger.debug('People directory query', {
      component: COMPONENT,
      directoryId,
      action,
      query: params.query,
      personId: params.personId
    });
    return result;
  } catch (error) {
    if (browse) {
      auditBrowse(params.user, directoryId, action, params, {
        error: error?.code || 'directory_error'
      });
    }
    if (error instanceof ToolArgumentError) {
      return { directory: directoryId, error: { code: error.code, message: error.message } };
    }
    logger.warn('People directory call failed', {
      component: COMPONENT,
      directoryId,
      action,
      userId: params.user?.id || null,
      code: error?.code,
      step: error?.step,
      error: error?.message,
      durationMs: Date.now() - startedAt
    });
    const code = error instanceof DirectoryConnectionError ? error.code : 'directory_error';
    return {
      directory: directoryId,
      error: { code, message: MODEL_ERROR_MESSAGES[code] || MODEL_ERROR_MESSAGES.default }
    };
  }
}

const MAX_RAW_VALUE_LENGTH = 300;

/**
 * Raw attributes as the admin test shows them, next to the mapped person.
 * Only mapped attributes were requested, so nothing secret is among them;
 * values are shortened and binary values summarised.
 */
function presentableEntry(entry) {
  const output = {};
  for (const [key, value] of Object.entries(entry || {})) {
    const values = (Array.isArray(value) ? value : [value]).map(item => {
      if (Buffer.isBuffer(item)) return `[binary, ${item.length} bytes]`;
      const text = String(item);
      return text.length > MAX_RAW_VALUE_LENGTH
        ? `${text.slice(0, MAX_RAW_VALUE_LENGTH)}… (${text.length} chars)`
        : text;
    });
    output[key] = values.length === 1 ? values[0] : values;
  }
  return output;
}

/** How many hits the admin test maps in detail. */
const TEST_SAMPLE_SIZE = 3;

/**
 * The admin connection test: resolve, SSRF check, connect, StartTLS, bind,
 * and a sample search, reported step by step. Changes nothing.
 *
 * @param {Object} raw - Saved or inline directory entry
 * @param {Object} [options]
 * @param {string} [options.query] - Name to search for
 * @param {Object} [options.deps] - `{ connectOptions }` for tests
 * @param {boolean} [options.unsaved] - An entry without an id of its own: it is
 *   queued by host, so tests of different new directories do not wait on each other
 * @returns {Promise<{success: boolean, message: string, summary: Object, steps: Object[], results?: Object[]}>}
 */
export async function testDirectory(raw, { query, deps = {}, unsaved = false } = {}) {
  const report = new DiagnosticsReport();
  const resolved = resolveDirectory(raw);
  const finish = (success, message, extra = {}) => ({
    success,
    message,
    summary: report.summary(),
    steps: report.steps,
    ...extra
  });

  const browseProblems = (resolved.browse?.problems || []).map(
    problem => `LDAP browser: ${problem}`
  );
  report.add({
    id: 'configuration',
    label: 'Effective configuration',
    status:
      resolved.problems.length > 0
        ? STATUS.FAIL
        : resolved.warnings.length > 0 || browseProblems.length > 0
          ? STATUS.WARN
          : STATUS.OK,
    message:
      resolved.problems.length > 0
        ? resolved.problems.join(' ')
        : `${resolved.url}, preset "${resolved.preset}", people under ${resolved.searchBase}`,
    details: {
      source: resolved.authProvider ? `sign-in provider "${resolved.authProvider}"` : 'direct',
      url: resolved.url || null,
      transport: resolved.transport,
      searchBase: resolved.searchBase || null,
      bind:
        resolved.bind?.mode === 'service'
          ? `service account ${resolved.bind.dn}`
          : resolved.bind?.mode || null,
      personFilter: resolved.personFilter,
      searchAttributes: resolved.searchAttributes,
      tlsCa: resolved.tlsCa,
      ignoredTlsOptionKeys: resolved.ignoredTlsOptionKeys,
      ldapBrowser: resolved.browse
        ? {
            base: resolved.browse.base || null,
            groups: resolved.browse.groups,
            bind: resolved.browse.ownBind
              ? `own account ${resolved.browse.bind?.dn || resolved.browse.bind?.mode}`
              : 'the directory bind',
            maxResults: resolved.browse.maxResults
          }
        : 'off',
      mapping: Object.fromEntries(
        Object.entries(resolved.mapping).map(([field, sources]) => [
          field,
          `${sources.join(' → ') || '—'}  (${resolved.mappingSources[field]})`
        ])
      )
    },
    hints: [...resolved.problems, ...resolved.warnings, ...browseProblems]
  });
  if (resolved.problems.length > 0) {
    return finish(false, 'The directory configuration is incomplete.');
  }

  const sample = typeof query === 'string' ? query.trim() : '';
  let prepared = null;
  if (sample) {
    try {
      prepared = prepareSearch(resolved, { query: sample });
    } catch (error) {
      report.add({
        id: 'search',
        label: 'Sample search',
        status: STATUS.FAIL,
        message: error.message
      });
      return finish(false, error.message);
    }
  }

  const labels = {
    network: 'Address check (SSRF)',
    connect: 'Connect',
    starttls: 'StartTLS',
    bind: 'Bind'
  };
  const queueId = unsaved ? `test:${hostOf(resolved.url) || 'unknown'}` : resolved.id;
  return inDirectoryQueue(
    resolved,
    async () => {
      let client;
      try {
        ({ client } = await openDirectoryConnection(resolved, {
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

      try {
        if (!prepared) {
          report.skip('search', 'Sample search', 'Enter a name to run a sample search.');
          return finish(true, 'Connected and bound. Enter a name to run a sample search.');
        }
        let outcome;
        const startedAt = Date.now();
        try {
          outcome = await runSearch(resolved, client, prepared);
        } catch (error) {
          report.add({
            id: 'search',
            label: 'Sample search',
            status: STATUS.FAIL,
            message: error.message,
            details: { filter: prepared.filter, base: resolved.searchBase },
            durationMs: Date.now() - startedAt
          });
          return finish(false, `The sample search failed: ${error.message}`);
        }
        const result = searchResult(resolved, prepared, outcome);
        report.add({
          id: 'search',
          label: 'Sample search',
          status: result.results.length > 0 ? STATUS.OK : STATUS.WARN,
          message: `${result.results.length} ${result.results.length === 1 ? 'person' : 'people'} found${result.truncated ? ' (more match)' : ''}`,
          details: {
            base: outcome.base,
            filter: prepared.filter,
            attributes: prepared.attributes,
            sizeLimit: prepared.sizeLimit
          },
          hints: result.hint ? [result.hint] : [],
          durationMs: Date.now() - startedAt
        });
        if (outcome.entries.length > 0) {
          report.add({
            id: 'mapping',
            label: 'Mapped people',
            status: STATUS.OK,
            message: `First ${Math.min(TEST_SAMPLE_SIZE, outcome.entries.length)} hit(s), with the attributes they came from`,
            details: {
              people: outcome.entries.slice(0, TEST_SAMPLE_SIZE).map(entry => {
                const { person, usedSources } = mapEntryToPerson(entry, {
                  directoryId: resolved.id,
                  mapping: resolved.mapping
                });
                return { person, usedSources, raw: presentableEntry(entry) };
              })
            }
          });
        }
        return finish(
          true,
          result.results.length > 0
            ? 'The directory answers.'
            : 'Connected, but nobody matched the sample search.',
          {
            results: result.results
          }
        );
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
