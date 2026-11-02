// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { expandUserGroups } from '../../utils/groupInheritance.js';
import { getLocalizedString } from '../../utils/localize.js';
import {
  ALLOWED_TLS_OPTION_KEYS,
  PEOPLE_DIRECTORY_DEFAULTS,
  peopleDirectorySchema
} from '../../validators/peopleDirectorySchema.js';
import {
  directoryFromInstance,
  getDirectoryInstallations
} from '../integrations/ldapDirectoryConfig.js';
import { mayUseIntegration } from '../integrations/integrationAccess.js';
import {
  DEFAULT_SEARCH_PRESET,
  SEARCH_PRESETS,
  resolveMapping,
  structuredFieldAttributes
} from './presets.js';
import { assertTransportAllowed, describeTransport, parseDirectoryUrl } from './transport.js';

/**
 * People directories: configuration resolution, who may use a directory, the
 * tools each directory offers, and the pieces the admin connection test and
 * the connector share.
 *
 * A directory is an installation of the built-in integration
 * `com.intrafind/ldap-directory`, "People directory (LDAP)" (Admin →
 * Integrations); this module reads those installations in the directory shape
 * of `validators/peopleDirectorySchema.js` (see `integrations/ldapDirectoryConfig.js`).
 *
 * Each enabled directory becomes its own small set of read-only tools —
 * `<id>__search_people`, `<id>__get_person` and, with `units`,
 * `<id>__list_units` — named and described after the directory, so the model
 * can tell which directory fits a question and call several when it needs to.
 * Nothing is merged server-side; every result names its directory. The tools
 * are the actions of the installation (the `ldapDirectory` connector); they
 * carry `_integration` like every installed integration's tools and
 * `_peopleDirectory` for the rules below.
 *
 * Who may use a directory is decided by the groups: their
 * `permissions.integrations` must grant the installation (`*`, its id, the
 * definition id or `type:people-directory`; see `integrationAccess.js`). The
 * grant is ANDed with the ordinary tool grants and checked wherever tools are
 * narrowed to a user (`mayUseDirectory`): the tool listing, an app's tools, a
 * direct tool run, the MCP gateway, and the tool itself when it runs.
 *
 * The admin LDAP browser is an integration of its own
 * (`com.intrafind/ldap-browser`) that reuses a directory's connection; its
 * resolution, access rule and tools are in `LdapBrowserService.js`, which
 * builds on `resolveDirectory` here.
 *
 * This module is on the path of every tool listing, so it opens nothing and
 * loads no LDAP client; running a tool and the admin test live in
 * peopleDirectoryRunner.js.
 */

const COMPONENT = 'PeopleDirectory';

/** Separator between a directory id and its action in a tool id. */
const TOOL_SEPARATOR = '__';

export const DIRECTORY_ACTIONS = ['search_people', 'get_person', 'list_units'];

const trimmed = value => (typeof value === 'string' ? value.trim() : '');

/**
 * Every configured directory: the installations of the LDAP directory
 * definition, in the directory shape.
 * @returns {Object[]}
 */
export function getConfiguredDirectories() {
  return getDirectoryInstallations().map(directoryFromInstance);
}

/**
 * A configured directory by id.
 * @param {string} id
 * @returns {Object|null}
 */
export function findDirectory(id) {
  return getConfiguredDirectories().find(directory => directory?.id === id) || null;
}

/**
 * The configured directory a tool id (`<id>__search_people`, …) belongs to,
 * read from the id alone, without loading any tools.
 * @param {string} toolId
 * @returns {string|null} The directory id
 */
export function directoryOfToolId(toolId) {
  if (typeof toolId !== 'string') return null;
  const at = toolId.indexOf(TOOL_SEPARATOR);
  if (at <= 0 || !DIRECTORY_ACTIONS.includes(toolId.slice(at + TOOL_SEPARATOR.length))) {
    return null;
  }
  const directory = findDirectory(toolId.slice(0, at));
  return directory ? directory.id : null;
}

/**
 * The directory tool a tool id names, read from the id alone, in the shape of
 * a tool's `_peopleDirectory` marker. An LDAP browser tool is not a directory
 * tool (see `LdapBrowserService.browserToolOfId`).
 * @param {string} toolId
 * @returns {{id: string, action: string}|null}
 */
export function directoryToolOfId(toolId) {
  const directoryId = directoryOfToolId(toolId);
  if (!directoryId) return null;
  return {
    id: directoryId,
    action: toolId.slice(toolId.indexOf(TOOL_SEPARATOR) + TOOL_SEPARATOR.length)
  };
}

/**
 * Host of an LDAP URL, or null.
 * @param {string} url
 * @returns {string|null}
 */
export function hostOf(url) {
  try {
    return parseDirectoryUrl(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a directory into everything a connection and a search need,
 * inheriting from the sign-in provider it references. Any field set on the
 * directory overrides the inherited one. Resolved at call time, so a provider
 * edit is picked up.
 *
 * @param {Object} raw - Directory entry (validated or not)
 * @param {Object} [platform] - Platform config (for `ldapAuth.providers`)
 * @returns {Object} The resolved directory, with `problems` (it cannot be used)
 *   and `warnings`
 */
export function resolveDirectory(raw, platform = configCache.getPlatform() || {}) {
  const problems = [];
  const warnings = [];
  const parsed = peopleDirectorySchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.') || 'entry'}: ${issue.message}`);
    }
  }
  const directory = parsed.success ? parsed.data : { ...PEOPLE_DIRECTORY_DEFAULTS, ...raw };

  let provider = null;
  if (directory.authProvider) {
    provider =
      (platform.ldapAuth?.providers || []).find(entry => entry?.name === directory.authProvider) ||
      null;
    if (!provider) {
      problems.push(`No LDAP sign-in provider named "${directory.authProvider}" is configured.`);
    }
  }

  const url = trimmed(directory.url) || trimmed(provider?.url);
  const starttls = directory.starttls ?? provider?.starttls ?? false;
  const baseDn = trimmed(directory.baseDn) || trimmed(provider?.baseDn);
  const searchBase =
    trimmed(directory.searchBase) ||
    trimmed(directory.baseDn) ||
    trimmed(provider?.userSearchBase) ||
    trimmed(provider?.baseDn);

  // From a sign-in provider only the allowed TLS keys are taken over. Its
  // `rejectUnauthorized: false` (or any other key) never reaches a search
  // connection: certificate policy comes from `tlsCa` and the SSL whitelist.
  const tlsOptions = {};
  const ignoredTlsOptionKeys = [];
  for (const [key, value] of Object.entries(provider?.tlsOptions || {})) {
    if (ALLOWED_TLS_OPTION_KEYS.includes(key)) tlsOptions[key] = value;
    else ignoredTlsOptionKeys.push(key);
  }
  Object.assign(tlsOptions, directory.tlsOptions || {});
  if (ignoredTlsOptionKeys.length > 0) {
    warnings.push(
      `The sign-in provider's TLS option(s) ${ignoredTlsOptionKeys.join(', ')} are ignored for people search; only ${ALLOWED_TLS_OPTION_KEYS.join(', ')} are taken over. Trust a private CA through tlsCa or the server's certificate store instead.`
    );
  }

  const presetId = SEARCH_PRESETS[directory.preset]
    ? directory.preset
    : SEARCH_PRESETS[provider?.preset]
      ? provider.preset
      : DEFAULT_SEARCH_PRESET;
  const preset = SEARCH_PRESETS[presetId];
  const { mapping, sources: mappingSources } = resolveMapping(presetId, directory.attributeMapping);

  let bind;
  if (directory.bind) {
    bind = directory.bind;
  } else if (provider && trimmed(provider.adminDn)) {
    bind = {
      mode: 'service',
      dn: trimmed(provider.adminDn),
      passwordRef: trimmed(provider.adminPasswordRef)
    };
    if (!bind.passwordRef) {
      problems.push(
        `The sign-in provider "${provider.name}" names a bind DN but no bind password credential.`
      );
    }
  } else if (provider) {
    bind = null;
    problems.push(
      `The sign-in provider "${provider.name}" has no bind account. iHub never keeps a user's LDAP password, so a search cannot run as the user: add a bind account to the provider, or set this directory's access to anonymous if the directory allows anonymous search (Active Directory normally does not).`
    );
  } else {
    bind = { mode: 'anonymous' };
  }

  if (!url) problems.push('No LDAP URL is configured.');
  if (!searchBase) problems.push('No base DN or search base is configured.');

  const resolved = {
    id: directory.id,
    enabled: directory.enabled !== false,
    type: directory.type || 'ldap',
    name: directory.name,
    description: directory.description,
    authProvider: directory.authProvider || null,
    providerHost: provider ? hostOf(provider.url) : null,
    url,
    starttls: starttls === true,
    baseDn,
    searchBase,
    preset: presetId,
    tlsOptions,
    ignoredTlsOptionKeys,
    bind,
    personFilter: trimmed(directory.personFilter) || preset.personFilter,
    searchAttributes:
      Array.isArray(directory.searchAttributes) && directory.searchAttributes.length > 0
        ? directory.searchAttributes
        : preset.searchAttributes,
    mapping,
    mappingSources,
    units: directory.units === true,
    allowPlaintext: directory.allowPlaintext === true,
    tlsCa: directory.tlsCa || [],
    allowedHosts: directory.allowedHosts || [],
    maxResults: directory.maxResults ?? PEOPLE_DIRECTORY_DEFAULTS.maxResults,
    timeoutMs: directory.timeoutMs ?? PEOPLE_DIRECTORY_DEFAULTS.timeoutMs,
    concurrency: directory.concurrency ?? PEOPLE_DIRECTORY_DEFAULTS.concurrency,
    requestDelayMs: directory.requestDelayMs ?? PEOPLE_DIRECTORY_DEFAULTS.requestDelayMs,
    dataFlow: directory.dataFlow || 'internal'
  };
  resolved.transport = url ? describeTransport(resolved) : 'unknown';

  if (url) {
    try {
      assertTransportAllowed(resolved);
    } catch (error) {
      problems.push(error.message);
    }
    if (resolved.transport === 'plaintext' && resolved.allowPlaintext) {
      warnings.push(
        'This ldap:// connection is not encrypted, so search terms and the people found cross the network in plain text. Use an ldaps:// URL (port 636) or enable StartTLS.'
      );
    }
    if (resolved.transport === 'ldaps' && directory.starttls === true) {
      warnings.push(
        'StartTLS is ignored for ldaps:// URLs: the connection is encrypted from the start.'
      );
    }
  }

  resolved.problems = problems;
  resolved.warnings = warnings;
  return resolved;
}

export { expandUserGroups };

/**
 * Whether a user may use a directory: its installation exists and is
 * enabled, and the user's groups grant it (`permissions.integrations`). Fails
 * closed: an unknown directory or an error means no; a missing user is the
 * anonymous principal, with the anonymous groups' grants.
 *
 * @param {Object|null} user - Enhanced user (`req.user`, the tool call's `user`)
 * @param {string} directoryId
 * @returns {boolean}
 */
export function mayUseDirectory(user, directoryId) {
  try {
    const instance = getDirectoryInstallations().find(entry => entry?.id === directoryId);
    if (!instance || instance.enabled === false) return false;
    return mayUseIntegration(instance, user);
  } catch (error) {
    logger.warn('People directory access check failed; denying', {
      component: COMPONENT,
      directoryId,
      error: error.message
    });
    return false;
  }
}

/**
 * Whether a user may use one directory tool: the group grant of its
 * installation (`mayUseDirectory`).
 *
 * @param {Object|null} user
 * @param {{id?: string, action?: string}|null} marker - A tool's `_peopleDirectory`
 * @returns {boolean}
 */
export function mayUseDirectoryTool(user, marker) {
  if (!marker?.id) return false;
  return mayUseDirectory(user, marker.id);
}

/**
 * Drop the directory tools a user may not use. Other tools pass.
 * @param {Object[]} tools
 * @param {Object|null} user
 * @returns {Object[]}
 */
export function filterDirectoryToolsForUser(tools, user) {
  return tools.filter(
    tool => !tool?._peopleDirectory || mayUseDirectoryTool(user, tool._peopleDirectory)
  );
}

/**
 * The last problem logged per `<kind>:<directoryId>`, so each is reported once
 * and again only when it changes. Bounded by the configured directories.
 */
const reportedProblems = new Map();

/**
 * Log a directory problem once per `<kind>:<directoryId>`, and again only when
 * it changes (the tool listing runs often).
 */
export function reportDirectoryProblemOnce(key, detail, message, meta) {
  if (reportedProblems.get(key) === detail) return;
  reportedProblems.set(key, detail);
  logger.warn(message, { component: COMPONENT, ...meta });
}

const ACTION_TEXT = {
  search_people: {
    en: max =>
      `Search people in this directory by name, e-mail address or a few words. Every word needs at least 2 characters and matches anywhere in a name; no wildcards. Returns at most ${max} people; on "truncated": true, narrow the search instead of paging.`,
    de: max =>
      `Personen in diesem Verzeichnis nach Name, E-Mail-Adresse oder einigen Wörtern suchen. Jedes Wort braucht mindestens 2 Zeichen und passt überall im Namen; keine Platzhalter. Liefert höchstens ${max} Personen; bei "truncated": true die Suche eingrenzen statt weiterzublättern.`
  },
  get_person: {
    en: () =>
      'Get all details of one person from this directory by the personId of a search result.',
    de: () =>
      'Alle Angaben zu einer Person aus diesem Verzeichnis anhand der personId eines Suchtreffers abrufen.'
  },
  list_units: {
    en: () =>
      'List the units (authorities, departments, sites) this directory can be narrowed to. Pass a unitId as "unit" to search_people.',
    de: () =>
      'Die Organisationseinheiten (Behörden, Abteilungen, Standorte) auflisten, auf die sich dieses Verzeichnis eingrenzen lässt. Eine unitId als "unit" an search_people übergeben.'
  }
};

const ACTION_NAME = {
  search_people: { en: 'search people', de: 'Personen suchen' },
  get_person: { en: 'get person', de: 'Person abrufen' },
  list_units: { en: 'list units', de: 'Einheiten auflisten' }
};

const STRUCTURED_DESCRIPTIONS = {
  firstName: 'First name, matched as a prefix.',
  lastName: 'Surname, matched as a prefix.',
  email: 'E-mail address, matched as a prefix.',
  jobTitle: 'Function or job title, matched as a prefix (e.g. "Präsident").',
  department: 'Organisational unit or department, matched as a prefix.'
};

/**
 * The tool definitions of one resolved directory.
 * @param {Object} resolved
 * @param {string} language
 * @returns {Object[]}
 */
export function buildDirectoryTools(resolved, language = 'en') {
  const lang = language === 'de' ? 'de' : 'en';
  const directoryName =
    getLocalizedString(resolved.name, language, 'en', resolved.id) || resolved.id;
  const directoryDescription = getLocalizedString(resolved.description, language, 'en', '');
  const describe = (action, text) =>
    [`${directoryName}${directoryDescription ? ` – ${directoryDescription}` : ''}`, text]
      .filter(Boolean)
      .join('\n');
  const toolBase = action => ({
    id: `${resolved.id}${TOOL_SEPARATOR}${action}`,
    name: `${directoryName}: ${ACTION_NAME[action][lang]}`,
    enabled: true,
    dataFlow: resolved.dataFlow,
    readOnly: true,
    _peopleDirectory: { id: resolved.id, action }
  });

  const searchProperties = {
    query: {
      type: 'string',
      description:
        'Name, e-mail address or a few words, e.g. "Erika Mustermann". At least 2 characters per word; no wildcards.'
    }
  };
  for (const field of Object.keys(structuredFieldAttributes(resolved))) {
    searchProperties[field] = { type: 'string', description: STRUCTURED_DESCRIPTIONS[field] };
  }
  if (resolved.units) {
    searchProperties.unit = {
      type: 'string',
      description: 'Search only inside this unit: a unitId from list_units of this directory.'
    };
  }
  searchProperties.maxResults = {
    type: 'integer',
    minimum: 1,
    maximum: resolved.maxResults,
    description: `How many people to return, 1 to ${resolved.maxResults}. Leave out for up to ${resolved.maxResults}.`
  };

  const tools = [
    {
      ...toolBase('search_people'),
      description: describe('search_people', ACTION_TEXT.search_people[lang](resolved.maxResults)),
      parameters: { type: 'object', properties: searchProperties, required: ['query'] }
    },
    {
      ...toolBase('get_person'),
      description: describe('get_person', ACTION_TEXT.get_person[lang]()),
      parameters: {
        type: 'object',
        properties: {
          personId: {
            type: 'string',
            description: 'The personId of a result of search_people from this directory.'
          }
        },
        required: ['personId']
      }
    }
  ];
  if (resolved.units) {
    tools.push({
      ...toolBase('list_units'),
      description: describe('list_units', ACTION_TEXT.list_units[lang]()),
      parameters: { type: 'object', properties: {} }
    });
  }
  return tools;
}

/**
 * A short summary per directory for the admin list.
 * @param {Object} raw
 * @param {Object} [platform]
 * @returns {Object}
 */
export function summarizeDirectory(raw, platform = configCache.getPlatform() || {}) {
  const resolved = resolveDirectory(raw, platform);
  return {
    sourceType: resolved.authProvider ? 'authProvider' : 'direct',
    source: resolved.authProvider || hostOf(resolved.url) || null,
    preset: resolved.preset,
    transport: resolved.transport,
    external: resolved.dataFlow === 'external',
    problems: resolved.problems,
    warnings: resolved.warnings
  };
}
