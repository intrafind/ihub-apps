// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The key facts of an installation: the two to four values an admin needs to
 * recognise it at a glance on its tile (Admin → Integrations → Installed) and
 * on the Overview tab of its page — the iFinder base URL and sign-in, the
 * directory URL and base DN, which web search keys are set, …
 *
 * The facts are chosen per definition (`FACTS_BY_DEFINITION`), then per
 * protocol, then by a generic rule (the first URL-like value). The module is
 * pure: it returns translation keys with English defaults, and
 * `IntegrationFactList` translates them.
 *
 * **Secrets are never shown.** A `secret` or `credential` field, a field the
 * definition marks `sensitive`, a key that looks like one (`…Ref`, `…Secret`,
 * `password`, `apiKey`, `apiToken`) and the managed service-account secret
 * (`auth.credentialRef`) only ever produce "set" or "not set" — the value,
 * even a credential id, never reaches the output.
 *
 * To add facts for a new definition, add an entry to `FACTS_BY_DEFINITION`
 * built from `fieldFact`, `choiceFact`, `secretFact` and `credentialFact`.
 *
 * @module features/admin/components/integrations/integrationFacts
 */

/**
 * One fact as the UI renders it: a translated label and either `text` (a URL,
 * an id, a name — shown as is) or a translated value (`valueKey`).
 *
 * @typedef {Object} InstallationFact
 * @property {string} id - stable id (React key, tests)
 * @property {string} labelKey
 * @property {string} labelDefault
 * @property {string} [text] - the value as is; never set for a secret
 * @property {string} [valueKey] - a translated value instead of `text`
 * @property {string} [valueDefault]
 * @property {Object} [valueParams]
 * @property {boolean} [mono] - render in a monospace font (URLs, ids)
 * @property {'set'|'unset'} [secret] - present on a secret's fact: its state, nothing else
 */

/** At most this many facts on a tile. */
export const DEFAULT_FACT_LIMIT = 4;

const FACT_PREFIX = 'admin.integrations.facts';

/** Keys that hold a secret or a reference to one, whatever the definition says. */
const SECRET_KEY_PATTERN = /(Ref$|secret|password|passwd|apikey|api_key|apitoken|accesstoken)/i;

/** A label pair under `admin.integrations.facts.*`. */
function label(key, defaultValue) {
  return { labelKey: `${FACT_PREFIX}.${key}`, labelDefault: defaultValue };
}

function hasValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Whether the install field `key` holds a secret: by the definition's field
 * spec when the caller has the definition, and by the key name always.
 *
 * @param {string} key
 * @param {{ definition?: { install?: Array<{ key: string, type?: string, sensitive?: boolean }> } }} [context]
 * @returns {boolean}
 */
export function isSecretField(key, context = {}) {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  const field = context.definition?.install?.find(f => f.key === key);
  return Boolean(
    field && (field.sensitive || field.type === 'secret' || field.type === 'credential')
  );
}

/**
 * The fact of a secret: whether it is set. The value is read only to test it
 * for presence and is not part of the result.
 */
export function secretFact(id, labelPair, rawValue) {
  const set = hasValue(rawValue);
  return {
    id,
    ...labelPair,
    secret: set ? 'set' : 'unset',
    valueKey: set ? `${FACT_PREFIX}.secretSet` : `${FACT_PREFIX}.secretNotSet`,
    valueDefault: set ? 'set' : 'not set'
  };
}

/**
 * The fact of one install value. Strings and numbers are shown as is, lists
 * joined, booleans as yes / no; a secret field becomes a `secretFact`.
 *
 * @param {Object} item - the installation (`values`)
 * @param {string} key - the install field
 * @param {string} id
 * @param {{labelKey: string, labelDefault: string}} labelPair
 * @param {Object} [options]
 * @param {boolean} [options.mono]
 * @param {unknown} [options.fallback] - the definition's default, for a value not stored
 * @param {Object} [options.context] - `{ definition }`, for the secret check
 * @returns {InstallationFact|null} null when there is nothing to show
 */
export function fieldFact(item, key, id, labelPair, { mono = false, fallback, context } = {}) {
  const raw = item?.values?.[key];
  if (isSecretField(key, context)) return secretFact(id, labelPair, raw);
  const value = hasValue(raw) ? raw : fallback;
  if (!hasValue(value)) return null;
  if (typeof value === 'boolean') {
    return {
      id,
      ...labelPair,
      valueKey: value ? `${FACT_PREFIX}.yes` : `${FACT_PREFIX}.no`,
      valueDefault: value ? 'yes' : 'no'
    };
  }
  if (Array.isArray(value)) return { id, ...labelPair, text: value.map(String).join(', '), mono };
  if (typeof value === 'object') return null;
  return { id, ...labelPair, text: String(value), mono };
}

/**
 * The fact of a choice: a translated label per known value, the raw value
 * for any other.
 *
 * @param {string} id
 * @param {{labelKey: string, labelDefault: string}} labelPair
 * @param {unknown} value
 * @param {Object<string, [string, string]>} choices - value → [key, default]
 */
export function choiceFact(id, labelPair, value, choices) {
  if (!hasValue(value)) return null;
  const choice = choices[String(value)];
  if (!choice) return { id, ...labelPair, text: String(value) };
  return { id, ...labelPair, valueKey: choice[0], valueDefault: choice[1] };
}

/**
 * The managed secret of the sign-in mode (`auth.credentialRef`: a service
 * account's token, an OAuth client's secret), when the mode keeps one.
 */
export function credentialFact(item) {
  const mode = item?.auth?.mode;
  if (!mode || mode === 'none' || mode === 'oauth-user') return null;
  return secretFact('credential', label('credential', 'Credential'), item.auth?.credentialRef);
}

/** The names of the boolean source switches that are on, e.g. "My Drive, Shared drives". */
function sourcesFact(item, sources) {
  const on = sources.filter(([key]) => item?.values?.[key] === true).map(([, name]) => name);
  if (on.length === 0) return null;
  return { id: 'sources', ...label('sources', 'Sources'), text: on.join(', ') };
}

const IFINDER_AUTH = {
  ihubSigned: [`${FACT_PREFIX}.choices.ihubSigned`, 'JWT signed by iHub'],
  oidcTokenExchange: [`${FACT_PREFIX}.choices.oidcTokenExchange`, 'OIDC token exchange']
};

const WEB_SEARCH_ENGINES = {
  auto: [`${FACT_PREFIX}.choices.auto`, 'Auto'],
  brave: [`${FACT_PREFIX}.choices.brave`, 'Brave Search'],
  staan: [`${FACT_PREFIX}.choices.staan`, 'Staan'],
  qwant: [`${FACT_PREFIX}.choices.qwant`, 'Qwant']
};

const MCP_TRANSPORTS = {
  streamableHttp: [`${FACT_PREFIX}.choices.streamableHttp`, 'Streamable HTTP'],
  sse: [`${FACT_PREFIX}.choices.sse`, 'SSE'],
  websocket: [`${FACT_PREFIX}.choices.websocket`, 'WebSocket'],
  stdio: [`${FACT_PREFIX}.choices.stdio`, 'Local process (stdio)']
};

/** The label of another installation, for `instance` fields (iAssistant's iFinder). */
function installationName(id, context) {
  const other = context?.installations?.find(entry => entry?.id === id);
  return other?.label && other.label !== id ? `${other.label} (${id})` : id;
}

/**
 * Fact builders per definition id: `(item, context) => Array<InstallationFact|null>`.
 * Order matters: the first `limit` non-null facts are shown.
 */
const FACTS_BY_DEFINITION = {
  'com.intrafind/ifinder': (item, context) => {
    const values = item.values || {};
    const exchange = values.authMode === 'oidcTokenExchange';
    return [
      fieldFact(item, 'baseUrl', 'baseUrl', label('baseUrl', 'Base URL'), {
        mono: true,
        context
      }),
      choiceFact(
        'authMode',
        label('authentication', 'Authentication'),
        values.authMode || 'ihubSigned',
        IFINDER_AUTH
      ),
      exchange
        ? fieldFact(
            item,
            'tokenExchangeProvider',
            'oidcProvider',
            label('oidcProvider', 'OIDC provider'),
            {
              context
            }
          )
        : values.useOidcKeyPair === true
          ? {
              id: 'signingKey',
              ...label('signingKey', 'Signing key'),
              valueKey: `${FACT_PREFIX}.choices.oidcKeyPair`,
              valueDefault: 'iHub OIDC key pair'
            }
          : secretFact('signingKey', label('privateKey', 'Private key'), values.privateKeyRef),
      fieldFact(
        item,
        'defaultSearchProfile',
        'defaultSearchProfile',
        label('defaultSearchProfile', 'Default search profile'),
        {
          mono: true,
          fallback: 'searchprofile-standard',
          context
        }
      )
    ];
  },
  'com.intrafind/iassistant': (item, context) => {
    const values = item.values || {};
    const connection = values.connection || 'ifinder';
    return [
      {
        id: 'connection',
        ...label('runsOn', 'Runs on'),
        text: installationName(connection, context)
      },
      fieldFact(
        item,
        'defaultProfileId',
        'defaultProfileId',
        label('defaultProfile', 'Default profile'),
        {
          mono: true,
          context
        }
      ),
      fieldFact(
        item,
        'defaultSearchProfile',
        'defaultSearchProfile',
        label('defaultSearchProfile', 'Default search profile'),
        {
          mono: true,
          fallback: 'searchprofile-standard',
          context
        }
      ),
      fieldFact(
        item,
        'groundedOnly',
        'groundedOnly',
        label('groundedOnly', 'Answers from documents only'),
        {
          fallback: false,
          context
        }
      )
    ];
  },
  'com.intrafind/ldap-directory': (item, context) => {
    const values = item.values || {};
    return [
      values.authProvider
        ? fieldFact(
            item,
            'authProvider',
            'authProvider',
            label('signInProvider', 'Sign-in provider'),
            {
              context
            }
          )
        : fieldFact(item, 'url', 'url', label('directoryUrl', 'Directory URL'), {
            mono: true,
            context
          }),
      fieldFact(item, 'baseDn', 'baseDn', label('baseDn', 'Base DN'), { mono: true, context }),
      !values.authProvider && values.bindMode === 'service'
        ? secretFact('bindPassword', label('bindPassword', 'Bind password'), values.bindPasswordRef)
        : null,
      fieldFact(item, 'browse', 'browse', label('browse', 'LDAP browser'), { context })
    ];
  },
  'com.intrafind/entra-directory': (item, context) => [
    fieldFact(item, 'tenantId', 'tenantId', label('tenantId', 'Tenant ID'), {
      mono: true,
      context
    }),
    fieldFact(item, 'clientId', 'clientId', label('clientId', 'Client ID'), {
      mono: true,
      context
    }),
    secretFact('clientSecret', label('clientSecret', 'Client secret'), item.values?.clientSecretRef)
  ],
  'com.intrafind/web-search': item => [
    choiceFact(
      'defaultProvider',
      label('defaultEngine', 'Default engine'),
      item.values?.defaultProvider || 'auto',
      WEB_SEARCH_ENGINES
    ),
    secretFact('braveKey', label('braveKey', 'Brave API key'), item.values?.braveCredentialRef),
    secretFact('staanKey', label('staanKey', 'Staan API key'), item.values?.staanCredentialRef)
  ],
  'com.intrafind/office365': (item, context) => [
    fieldFact(item, 'tenantId', 'tenantId', label('tenantId', 'Tenant ID'), {
      mono: true,
      context
    }),
    fieldFact(item, 'clientId', 'clientId', label('clientId', 'Client ID'), {
      mono: true,
      context
    }),
    secretFact(
      'clientSecret',
      label('clientSecret', 'Client secret'),
      item.values?.clientSecretRef
    ),
    sourcesFact(item, [
      ['sourcePersonalDrive', 'OneDrive'],
      ['sourceFollowedSites', 'SharePoint'],
      ['sourceTeams', 'Teams']
    ])
  ],
  'com.intrafind/google-drive': (item, context) => [
    fieldFact(item, 'clientId', 'clientId', label('clientId', 'Client ID'), {
      mono: true,
      context
    }),
    secretFact(
      'clientSecret',
      label('clientSecret', 'Client secret'),
      item.values?.clientSecretRef
    ),
    sourcesFact(item, [
      ['sourceMyDrive', 'My Drive'],
      ['sourceSharedDrives', 'Shared drives'],
      ['sourceSharedWithMe', 'Shared with me']
    ])
  ],
  'com.intrafind/nextcloud': (item, context) => [
    fieldFact(item, 'serverUrl', 'serverUrl', label('serverUrl', 'Server URL'), {
      mono: true,
      context
    }),
    fieldFact(item, 'clientId', 'clientId', label('clientId', 'Client ID'), {
      mono: true,
      context
    }),
    secretFact('clientSecret', label('clientSecret', 'Client secret'), item.values?.clientSecretRef)
  ],
  'com.intrafind/jira': (item, context) => [
    fieldFact(item, 'siteUrl', 'siteUrl', label('siteUrl', 'Site URL'), { mono: true, context }),
    fieldFact(item, 'clientId', 'clientId', label('clientId', 'Client ID'), {
      mono: true,
      context
    }),
    secretFact('clientSecret', label('clientSecret', 'Client secret'), item.values?.clientSecretRef)
  ],
  'org.ckan/open-data-portal': (item, context) => [
    fieldFact(item, 'baseUrl', 'baseUrl', label('portalUrl', 'Portal URL'), {
      mono: true,
      context
    }),
    fieldFact(item, 'defaultFilter', 'defaultFilter', label('defaultFilter', 'Filter'), {
      mono: true,
      context
    }),
    fieldFact(item, 'maxRows', 'maxRows', label('maxRows', 'Results per search'), { context }),
    credentialFact(item)
  ]
};

/** Fact builders per protocol, for definitions without an entry of their own. */
const FACTS_BY_PROTOCOL = {
  mcp: (item, context) => {
    const values = item.values || {};
    const stdio = values.transport === 'stdio';
    return [
      stdio
        ? fieldFact(item, 'command', 'command', label('command', 'Command'), {
            mono: true,
            context
          })
        : fieldFact(item, 'url', 'url', label('serverUrl', 'Server URL'), { mono: true, context }),
      choiceFact('transport', label('transport', 'Transport'), values.transport, MCP_TRANSPORTS),
      credentialFact(item)
    ];
  },
  a2a: (item, context) => [
    fieldFact(item, 'cardUrl', 'cardUrl', label('agentCard', 'Agent Card'), {
      mono: true,
      context
    }),
    credentialFact(item)
  ]
};

/** The keys the generic rule looks at, in order: the first one set is the endpoint. */
const ENDPOINT_KEYS = ['baseUrl', 'url', 'serverUrl', 'siteUrl', 'cardUrl'];

function genericFacts(item, context) {
  const key = ENDPOINT_KEYS.find(k => hasValue(item?.values?.[k]));
  return [
    key
      ? fieldFact(item, key, 'endpoint', label('endpoint', 'Endpoint'), { mono: true, context })
      : null,
    credentialFact(item)
  ];
}

/** Whether a definition has facts of its own (not the protocol or the generic rule). */
export function hasDefinitionFacts(definitionId) {
  return Object.hasOwn(FACTS_BY_DEFINITION, definitionId);
}

/**
 * The key facts of an installation.
 *
 * @param {Object} item - an installation as the admin API lists it
 *   (`definition`, `protocol`, `values`, `auth`); on the installation page the
 *   values are the effective ones (defaults applied)
 * @param {Object} [options]
 * @param {Array<{ id: string, label?: string }>} [options.installations] - the
 *   other installations, to name the one an `instance` field points at
 * @param {Object} [options.definition] - the definition with its install
 *   fields, to recognise every secret field it declares
 * @param {number} [options.limit=DEFAULT_FACT_LIMIT]
 * @returns {InstallationFact[]}
 * @example
 *   installationFacts({ definition: 'com.intrafind/web-search',
 *                       values: { defaultProvider: 'brave', braveCredentialRef: 'brave-key' } });
 *   // → Default engine: Brave Search · Brave API key: set · Staan API key: not set
 */
export function installationFacts(
  item,
  { installations, definition, limit = DEFAULT_FACT_LIMIT } = {}
) {
  if (!item || typeof item !== 'object') return [];
  const context = { installations, definition };
  const build =
    FACTS_BY_DEFINITION[item.definition] || FACTS_BY_PROTOCOL[item.protocol] || genericFacts;
  return build(item, context).filter(Boolean).slice(0, limit);
}
