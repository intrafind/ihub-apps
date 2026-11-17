// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rules that decide whether an installation stays administrable.
 *
 * Pure functions over the bodies a writer holds (the stored `users.json`,
 * `groups.json` and `platform.json` as read under the lock), never over the
 * runtime cache: the cache can lag behind another worker's save. The routes
 * call them through `adminGuards.js`, which reads the bodies and turns a
 * failed rule into the refusal.
 *
 * Every function here fails closed: a sign-in method it does not know is a
 * method that does not survive, never one that does. "Enabled" means exactly
 * what the runtime means by it: a truthy `enabled` ({@link isMethodEnabled}),
 * so a `"true"` string from a `${VAR}` placeholder or an environment override
 * counts as on here too. Treating it as off would make the guard fail open:
 * the relative checks would never protect a route, or count an admin, that
 * the runtime lets sign in.
 *
 * What the runtime actually checks (verified, 2026-11):
 * - `auth.mode` is a label. No sign-in path is gated on it; `proxyAuth.js`
 *   reads it only to decide whether to log a warning. The gates are the
 *   per-method `enabled` flags.
 * - A local token is rejected on every request while `localAuth.enabled` is
 *   off (`jwtAuth.js`). OIDC, LDAP, NTLM and Teams tokens stay valid until
 *   they expire, but nobody can sign in again through a disabled method, so a
 *   disabled method is a lost route all the same.
 * - OIDC skips providers with `enabled: false`; LDAP has no per-provider flag.
 * - Proxy sign-in is on when `proxyAuth.enabled` is true OR the environment
 *   variable `PROXY_AUTH_ENABLED` is `true` (`proxyAuth.js`).
 * - The cache applies `${VAR}` placeholders and then `IHUB_PLATFORM__*`
 *   overrides (`configCache._resolveEntry`); {@link effectivePlatformConfig}
 *   does the same, so a method forced on by the environment counts as on.
 *
 * @module server/utils/authInvariants
 */

import { isAdminEligiblePrincipal, resolveGroupInheritance } from './authorization.js';
import { envOverridePath } from './configOverrides.js';
import { resolveEnvVarsInObject } from './envVars.js';

/** The top-level platform.json blocks that decide who can sign in. */
export const AUTH_CONFIG_KEYS = Object.freeze([
  'auth',
  'anonymousAuth',
  'proxyAuth',
  'localAuth',
  'oidcAuth',
  'ldapAuth',
  'ntlmAuth',
  'teamsAuth'
]);

/** The `IHUB_*` prefix of platform.json overrides (`configOverrides.js`). */
const PLATFORM_ENV_PREFIX = 'IHUB_PLATFORM__';

/**
 * Whether the auth blocks of two platform bodies differ.
 *
 * @param {Object|null} before - Stored platform.json before the change
 * @param {Object|null} after - The body about to be stored
 * @returns {boolean}
 */
export function authConfigChanged(before, after) {
  return AUTH_CONFIG_KEYS.some(
    key => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)
  );
}

/**
 * Parse an override value the way `configOverrides.js` does: JSON when it
 * parses (numbers, booleans, arrays), the raw string otherwise.
 *
 * @param {string} value
 * @returns {*}
 */
function parseEnvValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * The platform configuration as the running server would see it after
 * loading `stored`: `${VAR}` placeholders resolved, then every
 * `IHUB_PLATFORM__*` override applied, then `PROXY_AUTH_ENABLED`.
 *
 * Unlike `applyIhubEnvOverrides` it logs nothing (the values can be secrets)
 * and never changes `stored`.
 *
 * @param {Object|null} stored - platform.json as stored
 * @param {Object<string, string|undefined>} [env=process.env] - Environment to read overrides from
 * @returns {Object} A new object
 *
 * @example
 * // IHUB_PLATFORM__LOCAL_AUTH__ENABLED=true
 * effectivePlatformConfig({ localAuth: { enabled: false } }).localAuth.enabled; // true
 */
export function effectivePlatformConfig(stored, env = process.env) {
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const effective = resolveEnvVarsInObject(structuredClone(base));

  for (const [envKey, envValue] of Object.entries(env)) {
    const pathParts = envOverridePath(envKey, PLATFORM_ENV_PREFIX);
    if (!pathParts || envValue === undefined) continue;
    let current = effective;
    for (const key of pathParts.slice(0, -1)) {
      if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    current[pathParts[pathParts.length - 1]] = parseEnvValue(envValue);
  }

  return applySignInEnvFlags(effective, env);
}

/**
 * Apply the sign-in switches that the runtime reads from the environment and
 * not from the platform file: today `PROXY_AUTH_ENABLED=true` turns proxy
 * sign-in on (`proxyAuth.js`). The guards and the admin rescue both use this, so
 * they agree on which admins can sign in.
 *
 * @param {Object} platform - A platform body (not modified)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Object} The body with the env switches applied (a copy when changed)
 */
export function applySignInEnvFlags(platform, env = process.env) {
  const base = platform && typeof platform === 'object' ? platform : {};
  if (String(env.PROXY_AUTH_ENABLED ?? '').toLowerCase() === 'true') {
    return { ...base, proxyAuth: { ...base.proxyAuth, enabled: true } };
  }
  return base;
}

/**
 * Whether a sign-in method block is on, the way the runtime gates it: every
 * sign-in path tests `if (block.enabled)` (truthiness), not `=== true`
 * (`jwtAuth.js`, `proxyAuth.js`, `oidcAuth.js`, `ldapAuth.js`, `ntlmAuth.js`,
 * `teamsAuth.js`, `routes/auth.js`).
 *
 * @param {Object|undefined} block - `localAuth`, `oidcAuth`, …
 * @returns {boolean}
 *
 * @example
 * isMethodEnabled({ enabled: 'true' }); // true, as at runtime
 * isMethodEnabled({ enabled: false }); // false
 */
export function isMethodEnabled(block) {
  return Boolean(block?.enabled);
}

/**
 * Whether one of a persisted user's sign-in methods is enabled.
 *
 * The rule the admin rescue uses (`adminRescue.hasAnyAdmin`): a record with no
 * `authMethods` is a legacy local user when it has a password hash; an unknown
 * method counts as enabled there, because the rescue must not fire for a
 * method it does not understand. A method is enabled as the runtime reads it
 * ({@link isMethodEnabled}); the rescue used `=== true` before, which made it
 * fire while a `"true"`-string method still let its administrators sign in.
 *
 * @param {Object} user - A users.json record
 * @param {Object} platform - Effective platform configuration
 * @returns {boolean}
 */
export function isUserAuthMethodEnabled(user, platform) {
  const authMethods = user.authMethods || [];

  if (authMethods.length === 0) {
    if (user.passwordHash) {
      return isMethodEnabled(platform.localAuth);
    }
    return true;
  }

  return authMethods.some(method => {
    switch (method) {
      case 'local':
        return isMethodEnabled(platform.localAuth);
      case 'oidc':
        return isMethodEnabled(platform.oidcAuth);
      case 'proxy':
        return isMethodEnabled(platform.proxyAuth);
      case 'ntlm':
        return isMethodEnabled(platform.ntlmAuth);
      case 'ldap':
        return isMethodEnabled(platform.ldapAuth);
      case 'teams':
        return isMethodEnabled(platform.teamsAuth);
      default:
        return true;
    }
  });
}

/**
 * Whether a group of a resolved groups configuration grants admin access
 * (directly or through `inherits`; resolution already merged the parents).
 *
 * @param {Object} resolvedGroups - `resolveGroupInheritance` output
 * @param {string} groupId
 * @returns {boolean}
 */
function grantsAdmin(resolvedGroups, groupId) {
  const groups = resolvedGroups?.groups;
  if (!groups || typeof groupId !== 'string' || !Object.hasOwn(groups, groupId)) return false;
  return groups[groupId]?.permissions?.adminAccess === true;
}

/**
 * The ids of the groups that grant admin access after resolution.
 *
 * @param {Object} resolvedGroups - `resolveGroupInheritance` output
 * @returns {Set<string>}
 */
export function adminGroupIds(resolvedGroups) {
  return new Set(
    Object.keys(resolvedGroups?.groups || {}).filter(id => grantsAdmin(resolvedGroups, id))
  );
}

/**
 * Whether a persisted user is an administrator who can sign in: active, with
 * an enabled sign-in method, and in a group that grants admin access (also
 * through inheritance).
 *
 * @param {Object|undefined} user - A users.json record
 * @param {Object} resolvedGroups - Groups with inheritance resolved
 * @param {Object} platform - Effective platform configuration
 * @returns {boolean}
 */
export function isUsableAdmin(user, resolvedGroups, platform) {
  if (!user || typeof user !== 'object') return false;
  if (user.active === false) return false;
  if (!isUserAuthMethodEnabled(user, platform)) return false;
  const groups = Array.isArray(user.internalGroups) ? user.internalGroups : [];
  return groups.some(groupId => grantsAdmin(resolvedGroups, groupId));
}

/**
 * Every route by which an administrator can still sign in: the ids of the
 * usable persisted admins, plus `ldap:<provider>` / `ntlm` for an enabled
 * LDAP provider or NTLM whose default groups grant admin access.
 *
 * External group mappings are not counted, exactly as the admin rescue does
 * not count them: whether anyone in the directory holds the mapped group is
 * unknown here.
 *
 * @param {Object|null} usersData - users.json (`{ users: { id: record } }`)
 * @param {Object} resolvedGroups - Groups with inheritance resolved
 * @param {Object} platform - Effective platform configuration
 * @returns {string[]}
 */
export function listUsableAdmins(usersData, resolvedGroups, platform) {
  const routes = [];
  const users = usersData?.users && typeof usersData.users === 'object' ? usersData.users : {};
  for (const [userId, user] of Object.entries(users)) {
    if (isUsableAdmin(user, resolvedGroups, platform)) routes.push(userId);
  }

  const ldap = platform.ldapAuth;
  if (isMethodEnabled(ldap) && Array.isArray(ldap.providers)) {
    for (const provider of ldap.providers) {
      const defaults = Array.isArray(provider?.defaultGroups) ? provider.defaultGroups : [];
      if (defaults.some(groupId => grantsAdmin(resolvedGroups, groupId))) {
        routes.push(`ldap:${provider.name}`);
      }
    }
  }

  const ntlm = platform.ntlmAuth;
  if (isMethodEnabled(ntlm) && Array.isArray(ntlm.defaultGroups)) {
    if (ntlm.defaultGroups.some(groupId => grantsAdmin(resolvedGroups, groupId))) {
      routes.push('ntlm');
    }
  }
  return routes;
}

/**
 * How many routes to an administrator remain; see {@link listUsableAdmins}.
 * Zero means the admin rescue would make the next person who signs in an
 * administrator.
 *
 * @param {Object|null} usersData - users.json
 * @param {Object} resolvedGroups - Groups with inheritance resolved
 * @param {Object} platform - Effective platform configuration
 * @returns {number}
 */
export function countUsableAdmins(usersData, resolvedGroups, platform) {
  return listUsableAdmins(usersData, resolvedGroups, platform).length;
}

/**
 * The sign-in route of a request principal: the method (`authMode`, or
 * `authMethod` for proxy, NTLM and Teams sessions that carry no token) and
 * the provider within it (`authProvider` from the token, when it named one).
 *
 * `machine` is true for principals that never administer (OAuth clients,
 * static API keys, delegated tokens, agents): there is no human session of
 * theirs to keep.
 *
 * @param {Object|null|undefined} user - `req.user`
 * @returns {{ mode: string|null, provider: string|null, machine: boolean }}
 */
export function signInRouteOf(user) {
  if (!user) return { mode: null, provider: null, machine: false };
  const mode = user.authMode || user.authMethod || null;
  const provider = user.authProvider || null;
  return {
    mode: typeof mode === 'string' ? mode : null,
    provider: typeof provider === 'string' && provider ? provider : null,
    machine: !isAdminEligiblePrincipal(user)
  };
}

/**
 * Token modes whose users.json record may be keyed by something other than the
 * token subject; the same set `tokenUser.js` (`PROVIDER_MODES`) uses.
 */
const SUBJECT_KEYED_MODES = new Set(['oidc', 'ldap', 'teams', 'ntlm']);

/**
 * The users.json key of the caller's own record, found the way
 * `tokenUser.findRecord` finds it for every request: the id itself, or, for a
 * provider token, the record whose `<mode>Data.subject` is the id. The second
 * case is a token minted before the persisted id became the subject: its
 * `req.user.id` is the IdP subject, not the users.json key, and comparing ids
 * alone would let that admin deactivate or delete their own record.
 *
 * @param {Object|null} usersData - users.json
 * @param {Object|null|undefined} user - `req.user`
 * @returns {string|undefined} The key, or undefined when the caller has no record
 *
 * @example
 * callerRecordId({ users: { u1: { authMethods: ['oidc'], oidcData: { subject: 's' } } } },
 *   { id: 's', authMode: 'oidc' }); // 'u1'
 */
export function callerRecordId(usersData, user) {
  const users = usersData?.users && typeof usersData.users === 'object' ? usersData.users : {};
  const id = user?.id;
  if (typeof id !== 'string' || !id) return undefined;
  if (Object.hasOwn(users, id)) return id;
  const mode = user.authMode || user.authMethod;
  if (!SUBJECT_KEYED_MODES.has(mode)) return undefined;
  return Object.keys(users).find(key => {
    const record = users[key];
    return (
      Array.isArray(record?.authMethods) &&
      record.authMethods.includes(mode) &&
      record[`${mode}Data`]?.subject === id
    );
  });
}

/** The sign-in methods {@link routeSurvives} knows. Anything else never survives. */
export const KNOWN_SIGN_IN_MODES = Object.freeze([
  'local',
  'oidc',
  'ldap',
  'ntlm',
  'proxy',
  'teams'
]);

/**
 * The providers of a method that a sign-in can use.
 *
 * @param {Object|undefined} block - `oidcAuth` / `ldapAuth`
 * @returns {Object[]}
 */
function usableProviders(block) {
  const providers = Array.isArray(block?.providers) ? block.providers : [];
  return providers.filter(p => p && typeof p === 'object' && p.enabled !== false);
}

/**
 * Whether a provider-based method (OIDC, LDAP) still offers the caller's
 * provider; with no known provider, whether it offers any.
 *
 * @param {Object|undefined} block
 * @param {string|null} provider
 * @returns {boolean}
 */
function providerSurvives(block, provider) {
  if (!isMethodEnabled(block)) return false;
  const providers = usableProviders(block);
  return provider ? providers.some(p => p.name === provider) : providers.length > 0;
}

/**
 * Whether a person can still sign in by `route` under `platform`.
 *
 * | mode    | survives when                                                       |
 * |---------|---------------------------------------------------------------------|
 * | local   | `localAuth.enabled`, and the record is active with a password hash  |
 * | oidc    | `oidcAuth.enabled` and the provider is listed and not disabled       |
 * | ldap    | `ldapAuth.enabled` and the provider is listed                        |
 * | ntlm    | `ntlmAuth.enabled`                                                   |
 * | proxy   | `proxyAuth.enabled`                                                  |
 * | teams   | `teamsAuth.enabled`                                                  |
 * | other   | never                                                                |
 *
 * With no provider known (a token from before `authProvider` was read), the
 * whole method must stay enabled with at least one provider. A persisted
 * record that is deactivated never survives.
 *
 * @param {{ mode: string|null, provider: string|null }} route - From {@link signInRouteOf}
 * @param {Object} platform - Effective platform configuration
 * @param {Object|undefined} userRecord - The caller's users.json record, if any
 * @returns {boolean}
 */
export function routeSurvives(route, platform, userRecord) {
  if (!route || !KNOWN_SIGN_IN_MODES.includes(route.mode)) return false;
  if (userRecord && userRecord.active === false) return false;
  const p = platform || {};
  switch (route.mode) {
    case 'local':
      return (
        isMethodEnabled(p.localAuth) &&
        Boolean(userRecord) &&
        typeof userRecord.passwordHash === 'string' &&
        userRecord.passwordHash.length > 0
      );
    case 'oidc':
      return providerSurvives(p.oidcAuth, route.provider);
    case 'ldap':
      return providerSurvives(p.ldapAuth, route.provider);
    case 'ntlm':
      return isMethodEnabled(p.ntlmAuth);
    case 'proxy':
      return isMethodEnabled(p.proxyAuth);
    case 'teams':
      return isMethodEnabled(p.teamsAuth);
    default:
      return false;
  }
}

/**
 * The groups that name `groupId` in their `inherits` list.
 *
 * @param {Object<string, Object>} groups - The `groups` map of groups.json
 * @param {string} groupId
 * @returns {string[]} Sorted ids
 */
export function dependantsOf(groups, groupId) {
  return Object.entries(groups || {})
    .filter(([id, group]) => id !== groupId && Array.isArray(group?.inherits))
    .filter(([, group]) => group.inherits.includes(groupId))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Why a groups configuration does not resolve (a missing parent, a cycle), or
 * null when it does. A body that does not resolve must not be stored: the
 * cache would keep serving the previous groups, so revocations stop applying.
 *
 * @param {Object|null} groupsData - groups.json
 * @returns {string|null}
 */
export function groupsResolutionError(groupsData) {
  if (!groupsData?.groups) return null;
  try {
    resolveGroupInheritance(groupsData);
    return null;
  } catch (error) {
    return error?.message || 'Group inheritance does not resolve';
  }
}
