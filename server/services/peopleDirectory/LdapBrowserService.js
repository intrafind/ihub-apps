// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { isAdminEligiblePrincipal } from '../../utils/authorization.js';
import { getLocalizedString } from '../../utils/localize.js';
import { LDAP_BROWSE_DEFAULTS, ldapBrowserSchema } from '../../validators/peopleDirectorySchema.js';
import {
  BROWSER_ACTIONS,
  browserFromInstance,
  directoryFromInstance,
  getBrowserInstallations,
  getDirectoryInstallations
} from '../integrations/ldapDirectoryConfig.js';
import { mayUseIntegration } from '../integrations/integrationAccess.js';
import { resolveDirectory } from './PeopleDirectoryService.js';
import { assertTransportAllowed } from './transport.js';

/**
 * The admin LDAP browser (`com.intrafind/ldap-browser`): its configuration
 * resolution, who may use it, and the tools it offers. Running a tool and the
 * admin test live in `ldapBrowserRunner.js`; the LDAP operations in
 * `LdapBrowser.js`.
 *
 * A browser is an installation of its own that names a **People directory
 * (LDAP)** installation (`values.directory`) and reuses that directory's
 * connection: URL, StartTLS, TLS versions, trusted certificates, allowed
 * hosts, the reused sign-in provider, the base DN and — unless the browser
 * has an account of its own — the bind account. Its own settings are the
 * browse base, the result limit, further attributes to withhold and that
 * optional account.
 *
 * Every enabled browser offers `<browserId>__browse_search`,
 * `<browserId>__browse_read` and `<browserId>__browse_children`. They return
 * raw entries, so on top of the installation's group grant
 * (`permissions.integrations`):
 *
 * - only signed-in users browse, and never a delegated or machine principal
 *   (personal API keys, OAuth clients and tokens, agents), who could otherwise
 *   reach the browser through an app over MCP, A2A or the chat API;
 * - the directory the browser names must exist and be enabled;
 * - the tools are never offered over the MCP gateway, and every call is
 *   audited (`ldapBrowserRunner.js`).
 *
 * The tools carry `_ldapBrowser: { id, directory, action }` for these rules.
 * This module is on the path of every tool listing, so it opens nothing and
 * loads no LDAP client.
 */

const COMPONENT = 'LdapBrowser';

/** Separator between an installation id and its action in a tool id. */
const TOOL_SEPARATOR = '__';

/** The browser's actions (`com.intrafind/ldap-browser`). */
export { BROWSER_ACTIONS };

const trimmed = value => (typeof value === 'string' ? value.trim() : '');

/**
 * Every configured browser: the installations of the LDAP browser
 * definition, in the browser shape.
 * @returns {Object[]}
 */
export function getConfiguredBrowsers() {
  return getBrowserInstallations().map(browserFromInstance);
}

/**
 * A configured browser by its installation id.
 * @param {string} id
 * @returns {Object|null}
 */
export function findBrowser(id) {
  return getConfiguredBrowsers().find(browser => browser?.id === id) || null;
}

/**
 * The browser tool a tool id names (`<browserId>__browse_search`, …), read
 * from the id alone, in the shape of a tool's `_ldapBrowser` marker.
 * @param {string} toolId
 * @returns {{id: string, directory: string, action: string}|null}
 */
export function browserToolOfId(toolId) {
  if (typeof toolId !== 'string') return null;
  const at = toolId.indexOf(TOOL_SEPARATOR);
  if (at <= 0) return null;
  const action = toolId.slice(at + TOOL_SEPARATOR.length);
  if (!BROWSER_ACTIONS.includes(action)) return null;
  const browser = findBrowser(toolId.slice(0, at));
  return browser ? { id: browser.id, directory: browser.directory, action } : null;
}

/**
 * The directory installation a browser names, as stored, or null.
 * @param {string} directoryId
 * @returns {Object|null}
 */
function directoryInstallation(directoryId) {
  if (!directoryId) return null;
  return getDirectoryInstallations().find(entry => entry?.id === directoryId) || null;
}

/**
 * Resolve a browser into everything its connection and its tools need: the
 * resolved directory it reuses (connection), its base, its bind (its own, or
 * the directory's), its limits and deny list. Resolved at call time, so an
 * edit of the directory or of the sign-in provider is picked up.
 *
 * `problems` keep the browser from being offered (a missing directory, a
 * directory that does not resolve, no base, no bind, a bind that would cross
 * the network in plain text); a disabled directory is reported by
 * `directoryEnabled: false`, not as a problem, so the admin test can still
 * check the connection.
 *
 * @param {Object} raw - Browser entry (`browserFromInstance`), validated or not
 * @param {Object} [platform] - Platform config (for `ldapAuth.providers`)
 * @returns {{
 *   id: string, enabled: boolean, name?: Object, description?: Object,
 *   directoryId: string, directoryEnabled: boolean, directory: Object|null,
 *   base: string, maxResults: number, bind: Object|null, ownBind: boolean,
 *   denyAttributes: string[], dataFlow: string, transport: string,
 *   problems: string[], warnings: string[]
 * }}
 */
export function resolveBrowser(raw, platform = configCache.getPlatform() || {}) {
  const problems = [];
  const warnings = [];
  const parsed = ldapBrowserSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.') || 'entry'}: ${issue.message}`);
    }
  }
  const browser = parsed.success ? parsed.data : { ...raw };
  const directoryId = trimmed(browser.directory);

  const instance = directoryInstallation(directoryId);
  if (!directoryId) {
    problems.push('No people directory is selected: pick the directory whose connection to use.');
  } else if (!instance) {
    problems.push(`There is no People directory (LDAP) installation "${directoryId}".`);
  }
  const directory = instance ? resolveDirectory(directoryFromInstance(instance), platform) : null;
  if (directory) {
    for (const problem of directory.problems) {
      problems.push(`The directory "${directoryId}": ${problem}`);
    }
    warnings.push(...directory.warnings);
  }

  const base = trimmed(browser.base) || directory?.baseDn || '';
  const bind = browser.bind || directory?.bind || null;
  if (directory && !base) {
    problems.push(
      "The LDAP browser needs a base: set its browse base, or the directory's base DN."
    );
  }
  if (directory && !bind) {
    problems.push('The LDAP browser has no bind account: give it an account of its own.');
  }
  if (directory?.url && bind) {
    try {
      assertTransportAllowed({ ...directory, bind });
    } catch (error) {
      problems.push(error.message);
    }
  }

  return {
    id: browser.id,
    enabled: browser.enabled !== false,
    name: browser.name,
    description: browser.description,
    directoryId,
    directoryEnabled: Boolean(instance) && instance.enabled !== false,
    directory,
    base,
    maxResults: browser.maxResults ?? LDAP_BROWSE_DEFAULTS.maxResults,
    bind,
    ownBind: Boolean(browser.bind),
    denyAttributes: Array.isArray(browser.denyAttributes) ? browser.denyAttributes : [],
    dataFlow: directory?.dataFlow || 'internal',
    transport: directory?.transport || 'unknown',
    problems,
    warnings
  };
}

/**
 * Whether a user may use a browser: its installation exists and is enabled,
 * the directory it names exists and is enabled, the user is a signed-in,
 * non-delegated principal, and the user's groups grant the browser
 * installation (`permissions.integrations`: `*`, its id or
 * `com.intrafind/ldap-browser`). The directory's own grant is not needed.
 * Fails closed.
 *
 * @param {Object|null} user - Enhanced user (`req.user`, the tool call's `user`)
 * @param {string} browserId - The browser installation id
 * @returns {boolean}
 */
export function mayUseBrowser(user, browserId) {
  try {
    const instance = getBrowserInstallations().find(entry => entry?.id === browserId);
    if (!instance || instance.enabled === false) return false;
    const directory = directoryInstallation(browserFromInstance(instance).directory);
    if (!directory || directory.enabled === false) return false;
    if (!user?.id || user.id === 'anonymous') return false;
    if (!isAdminEligiblePrincipal(user)) return false;
    return mayUseIntegration(instance, user);
  } catch (error) {
    logger.warn('LDAP browser access check failed; denying', {
      component: COMPONENT,
      browserId,
      error: error.message
    });
    return false;
  }
}

/**
 * Drop the browser tools a user may not use (see {@link mayUseBrowser}).
 * Other tools pass.
 * @param {Object[]} tools
 * @param {Object|null} user
 * @returns {Object[]}
 */
export function filterBrowserToolsForUser(tools, user) {
  return tools.filter(tool => !tool?._ldapBrowser || mayUseBrowser(user, tool._ldapBrowser.id));
}

const BROWSE_TEXT = {
  browse_search: {
    en: max =>
      `Admin LDAP browser: search raw directory entries with an LDAP filter (RFC 4515), e.g. (&(objectClass=group)(cn=*admin*)). Returns entries with all their attributes as the server stores them, at most ${max}; on "truncated": true, narrow the filter or the base. Secret attributes are withheld and cannot be used in a filter.`,
    de: max =>
      `Admin-LDAP-Browser: Rohe Verzeichniseinträge mit einem LDAP-Filter (RFC 4515) suchen, z. B. (&(objectClass=group)(cn=*admin*)). Liefert Einträge mit allen Attributen, wie der Server sie speichert, höchstens ${max}; bei "truncated": true Filter oder Basis eingrenzen. Geheime Attribute werden zurückgehalten und können nicht in einem Filter vorkommen.`
  },
  browse_read: {
    en: () => 'Admin LDAP browser: read one entry by its full DN, with its raw attributes.',
    de: () =>
      'Admin-LDAP-Browser: Einen Eintrag anhand seines vollständigen DN mit seinen rohen Attributen lesen.'
  },
  browse_children: {
    en: () =>
      'Admin LDAP browser: list the direct children of a DN (default: the browse base) with their object classes, without attributes. Use it to walk the tree.',
    de: () =>
      'Admin-LDAP-Browser: Die direkten Kinder eines DN (Standard: die Browse-Basis) mit ihren Objektklassen auflisten, ohne Attribute. Damit den Baum durchlaufen.'
  }
};

const BROWSE_NAME = {
  browse_search: { en: 'LDAP browse search', de: 'LDAP-Browser-Suche' },
  browse_read: { en: 'LDAP browse read', de: 'LDAP-Browser lesen' },
  browse_children: { en: 'LDAP browse children', de: 'LDAP-Browser Kinder' }
};

/**
 * The tools of one resolved browser. The description names the browser, the
 * directory it reads and the base it is confined to, so the model can tell
 * several browsers apart.
 *
 * @param {Object} resolved - From {@link resolveBrowser}
 * @param {string} [language]
 * @returns {Object[]}
 */
export function buildBrowseTools(resolved, language = 'en') {
  const lang = language === 'de' ? 'de' : 'en';
  const browserName = getLocalizedString(resolved.name, language, 'en', resolved.id) || resolved.id;
  const directoryName =
    getLocalizedString(resolved.directory?.name, language, 'en', resolved.directoryId) ||
    resolved.directoryId;
  const { base, maxResults } = resolved;
  const tool = (action, parameters) => ({
    id: `${resolved.id}${TOOL_SEPARATOR}${action}`,
    name: `${browserName}: ${BROWSE_NAME[action][lang]}`,
    description: `${browserName} – ${directoryName} (${base})\n${BROWSE_TEXT[action][lang](maxResults)}`,
    enabled: true,
    dataFlow: resolved.dataFlow,
    readOnly: true,
    parameters,
    _ldapBrowser: { id: resolved.id, directory: resolved.directoryId, action }
  });
  const dn = description => ({ type: 'string', description });
  const attributes = {
    type: 'array',
    items: { type: 'string' },
    description:
      'Attribute names to return. Leave out for all user attributes; name operational attributes (e.g. memberOf, createTimestamp) to get them.'
  };
  return [
    tool('browse_search', {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'An LDAP filter in parentheses, e.g. (&(objectClass=person)(sn=Muster*)).'
        },
        base: dn(`DN to search under, inside ${base}. Leave out for ${base}.`),
        scope: {
          type: 'string',
          enum: ['base', 'one', 'sub'],
          description:
            'base: only the base entry; one: its direct children; sub (default): the whole subtree.'
        },
        attributes,
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: maxResults,
          description: `How many entries to return, 1 to ${maxResults}.`
        }
      },
      required: ['filter']
    }),
    tool('browse_read', {
      type: 'object',
      properties: { dn: dn(`The full DN of the entry, inside ${base}.`), attributes },
      required: ['dn']
    }),
    tool('browse_children', {
      type: 'object',
      properties: { dn: dn(`The full DN whose children to list. Leave out for ${base}.`) }
    })
  ];
}

/**
 * A short summary of a browser for the admin list: whether it resolves, the
 * transport of the directory it reuses, and whether that directory is
 * external.
 * @param {Object} raw - Browser entry
 * @param {Object} [platform]
 * @returns {{directory: string, base: string, transport: string, external: boolean,
 *   directoryEnabled: boolean, problems: string[], warnings: string[]}}
 */
export function summarizeBrowser(raw, platform = configCache.getPlatform() || {}) {
  const resolved = resolveBrowser(raw, platform);
  const warnings = [...resolved.warnings];
  if (resolved.directory && !resolved.directoryEnabled) {
    warnings.push(
      `The directory "${resolved.directoryId}" is disabled; the browser offers no tools until it is enabled.`
    );
  }
  return {
    directory: resolved.directoryId,
    base: resolved.base,
    transport: resolved.transport,
    external: resolved.dataFlow === 'external',
    directoryEnabled: resolved.directoryEnabled,
    problems: resolved.problems,
    warnings
  };
}
