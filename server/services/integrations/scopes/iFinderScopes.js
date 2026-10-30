// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iFinder scopes: the search profiles a user may search in ("search in …").
 *
 * The list is the user's own, as iFinder's searchbar offers it
 * (`iFinderSearchProfiles`, read as the user), narrowed to the admin's
 * allow-list (`iFinder.allowedSearchProfiles`). When it cannot be read — a
 * user without the feature `fi_ifinder_allow` gets 403, or iFinder is down —
 * the configured default and the allow-list are offered instead, never an
 * empty list.
 *
 * A scope is fixed when the app pins one (`integrations.ifinder.pinnedScope`)
 * or the installation does not let users change the profile
 * (`iFinder.allowUserSearchProfileChange: false`, which pins the default).
 *
 * {@link resolveToolSearchProfile} is what binds the `iFinder_*` tools: the
 * chat's scope wins over whatever `searchProfile` the model passes.
 */
import iFinderService from '../iFinderService.js';
import iFinderSearchProfiles from '../iFinderSearchProfiles.js';
import configCache from '../../../configCache.js';
import logger from '../../../utils/logger.js';
import { appScopeSettings, pickDefaultScope } from './common.js';

export const INTEGRATION_ID = 'ifinder';

/** Prefix of the tools that belong to the iFinder integration. */
const TOOL_PREFIX = 'iFinder_';

/** A scope the user may not search in. */
export class SearchProfileNotAllowedError extends Error {
  constructor(searchProfile, available = []) {
    super(
      `The iFinder search profile "${searchProfile}" is not available to you.` +
        (available.length ? ` Available profiles: ${available.join(', ')}.` : '')
    );
    this.name = 'SearchProfileNotAllowedError';
    this.code = 'INTEGRATION_SCOPE_NOT_ALLOWED';
    this.searchProfile = searchProfile;
  }
}

function isSignedIn(user) {
  return Boolean(user?.id) && user.id !== 'anonymous';
}

/** Whether the admin allow-list lets a profile be offered. */
function isAllowed(cfg, profileId) {
  return (
    cfg.allowedSearchProfiles.length === 0 ||
    cfg.allowedSearchProfiles.includes(profileId) ||
    profileId === cfg.defaultSearchProfile
  );
}

/** The scope pinned for every chat of the app, or null. */
function pinnedScope(cfg, app) {
  const { pinnedScope: appPinned } = appScopeSettings(app, INTEGRATION_ID);
  if (appPinned) return appPinned;
  return cfg.allowUserSearchProfileChange ? null : cfg.defaultSearchProfile;
}

const iFinderScopes = {
  id: INTEGRATION_ID,
  name: { en: 'iFinder', de: 'iFinder' },
  // A scope is where the integration searches ("search in …").
  action: 'search',

  // With a scope set there is no other profile to switch to.
  hiddenToolsWhenScoped: Object.freeze([`${TOOL_PREFIX}listProfiles`]),

  /** What the model is told about a chat bound to one search profile. */
  describeForModel(scopeId) {
    return (
      `iFinder search profile: every iFinder tool call in this conversation searches the ` +
      `search profile "${scopeId}", which is fixed for this chat. Do not pass another ` +
      '`searchProfile` and do not look for other search profiles; when a search finds ' +
      'nothing, refine the query or the filters instead.'
    );
  },

  appliesTo({ app }) {
    if (configCache.getPlatform()?.iFinder?.enabled !== true) return false;
    return Array.isArray(app?.tools) && app.tools.some(id => String(id).startsWith(TOOL_PREFIX));
  },

  /**
   * The user's search profiles, narrowed to the allow-list.
   * @returns {Promise<{ scopes: Array, defaultScope: string, fixed: boolean,
   *   source: 'ifinder'|'configured-default', hint?: string }>}
   */
  async listScopes({ user, app, signal }) {
    const cfg = iFinderService.getConfig();

    let profiles = null;
    let hint;
    if (isSignedIn(user) && cfg.baseUrl) {
      try {
        profiles = await iFinderSearchProfiles.getUserSearchProfiles({
          user,
          baseUrl: cfg.baseUrl,
          application: cfg.searchProfileApplication,
          timeout: cfg.timeout,
          signal
        });
      } catch (error) {
        hint = error?.status === 403 ? 'forbidden' : 'unavailable';
        logger.debug('Could not read the search profiles of the user; offering the defaults', {
          component: 'IFinderScopes',
          status: error?.status,
          error: error?.message
        });
      }
    } else {
      hint = 'unavailable';
    }

    let scopes = (profiles || [])
      .filter(profile => isAllowed(cfg, profile.id))
      .map(profile => ({ id: profile.id, name: profile.name, userDefault: profile.isDefault }));
    let source = 'ifinder';
    if (!profiles) {
      source = 'configured-default';
      scopes = [...new Set([cfg.defaultSearchProfile, ...cfg.allowedSearchProfiles])].map(id => ({
        id,
        name: id
      }));
    } else if (scopes.length === 0) {
      // A user with none of the allowed profiles still gets the default; the
      // search itself then reports what iFinder thinks of it.
      source = 'configured-default';
      hint = 'no-profiles';
      scopes = [{ id: cfg.defaultSearchProfile, name: cfg.defaultSearchProfile }];
    }

    const pinned = pinnedScope(cfg, app);
    if (pinned) {
      const known = scopes.find(scope => scope.id === pinned);
      scopes = [{ id: pinned, name: known?.name || pinned }];
    }

    const { defaultScope: appDefault } = appScopeSettings(app, INTEGRATION_ID);
    const defaultScope = pickDefaultScope(scopes, pinned || appDefault || cfg.defaultSearchProfile);
    return {
      scopes: scopes.map(({ id, name }) => ({ id, name, isDefault: id === defaultScope })),
      defaultScope,
      fixed: Boolean(pinned),
      // Whether the list is the user's own: a list that could not be read is
      // only the configured default, so a scope outside it cannot be judged.
      verified: source === 'ifinder',
      source,
      ...(hint ? { hint } : {})
    };
  },

  async validateScope({ scopeId, user, app, signal }) {
    // Nothing picked and nothing pinned: no list to check against.
    if (!scopeId && !pinnedScope(iFinderService.getConfig(), app)) {
      return { ok: true, scopeId: null, fixed: false };
    }
    const listing = await this.listScopes({ user, app, signal });
    if (listing.fixed) return { ok: true, scopeId: listing.defaultScope, fixed: true };
    if (!scopeId) return { ok: true, scopeId: null, fixed: false };
    // The configured default is the admin's own choice and always allowed,
    // as it was before scopes existed, even for a user who lacks it.
    const cfg = iFinderService.getConfig();
    if (
      scopeId === cfg.defaultSearchProfile ||
      listing.scopes.some(scope => scope.id === scopeId)
    ) {
      return { ok: true, scopeId, fixed: false };
    }
    // The list could not be read and no allow-list narrows it: whether the
    // user has the profile is unknown, so it is passed on as is — the same
    // soft check iAssistant applies (`verifySearchProfileAccess`).
    if (!listing.verified && cfg.allowedSearchProfiles.length === 0) {
      return { ok: true, scopeId, fixed: false };
    }
    return {
      ok: false,
      code: 'INTEGRATION_SCOPE_NOT_ALLOWED',
      message: new SearchProfileNotAllowedError(scopeId).message,
      available: listing.scopes.map(scope => scope.id)
    };
  }
};

/**
 * The search profile an `iFinder_*` tool call searches.
 *
 * The chat's scope (`integrationScopes.ifinder`, set by iHub after the model's
 * arguments) wins over the model's `searchProfile`; a fixed scope wins over
 * both. A profile the model picks itself is checked like a picked scope.
 *
 * @param {Object} params - the tool call's params
 * @param {string} [params.searchProfile] - what the model asked for
 * @param {Object} [params.integrationScopes] - the chat's scopes
 * @param {Object} params.user
 * @param {Object} [params.appConfig]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ searchProfile: string, fixed: boolean }>}
 * @throws {SearchProfileNotAllowedError}
 */
export async function resolveToolSearchProfile({
  searchProfile,
  integrationScopes,
  user,
  appConfig,
  signal
}) {
  const cfg = iFinderService.getConfig();
  const chosen =
    typeof integrationScopes?.[INTEGRATION_ID] === 'string'
      ? integrationScopes[INTEGRATION_ID]
      : null;
  const requested = chosen || (typeof searchProfile === 'string' ? searchProfile : null);

  // Nothing asked for and nothing pinned: the default, without a lookup.
  if (!requested && !pinnedScope(cfg, appConfig)) {
    return { searchProfile: cfg.defaultSearchProfile, fixed: false };
  }

  const result = await iFinderScopes.validateScope({
    scopeId: requested,
    user,
    app: appConfig,
    signal
  });
  if (!result.ok) throw new SearchProfileNotAllowedError(requested, result.available);
  if (chosen && searchProfile && searchProfile !== result.scopeId) {
    logger.debug('The model named another search profile than the chat; using the chat scope', {
      component: 'IFinderScopes',
      requested: searchProfile,
      searchProfile: result.scopeId
    });
  }
  return {
    searchProfile: result.scopeId || cfg.defaultSearchProfile,
    fixed: Boolean(chosen) || result.fixed
  };
}

export default iFinderScopes;
