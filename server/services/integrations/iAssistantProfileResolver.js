/**
 * Resolves the iFinder *search* profile that belongs to an iAssistant
 * *conversation* profile.
 *
 * The two are different things and are configured in different places:
 *
 *   - the conversation profile (`message.profile_id`, e.g. `iassistant-workspace`)
 *     selects a workflow and its parameter overrides;
 *   - the search profile (`retrieval_scope.ifinder_search_profile`, e.g.
 *     `searchprofile-standard`) selects which documents retrieval may see.
 *
 * Administrators reasonably expect the first to imply the second — a profile
 * built for one corpus should not have to be paired by hand with the matching
 * search profile in every app that uses it. So iHub asks the profile first and
 * only falls back to what the app, the model or the platform configured.
 *
 * As of iFinder 6.9 the Conversation API does not expose a search profile on a
 * profile: `WorkflowConfiguration` carries `workflow`, `state_defaults` and
 * `states`, none of which is documented to hold one, and retrieval reads the
 * search profile solely from `retrieval_scope`. The lookup below is therefore
 * written to find one wherever it might plausibly appear and to return null
 * when it does not, so the configured fallback keeps applying today and the
 * profile takes over by itself once iFinder starts publishing it.
 *
 * Every failure here is soft. A conversation that cannot be created is a
 * broken chat; a search profile that could not be read is just the fallback.
 */
import conversationApiService from './ConversationApiService.js';
import iAssistantService from './iAssistantService.js';
import logger from '../../utils/logger.js';

/**
 * Keys a search profile could be published under, in the snake_case the API
 * uses and the camelCase the workflow configuration uses for its parameters.
 */
const SEARCH_PROFILE_KEYS = [
  'ifinder_search_profile',
  'ifinderSearchProfile',
  'search_profile',
  'searchProfile'
];

class IAssistantProfileResolver {
  constructor() {
    /** @type {Map<string, { value: string|null, expiresAt: number }>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<string|null>>} in-flight lookups, keyed as the cache */
    this.inFlight = new Map();
  }

  /** Drop every cached profile. Called from the config reload hooks. */
  reset() {
    this.cache.clear();
    this.inFlight.clear();
  }

  /**
   * The search profile a conversation should be created with.
   *
   * @param {Object} params
   * @param {string} [params.profileId] - the iAssistant conversation profile
   * @param {string} [params.configuredSearchProfile] - app/model/platform value
   * @param {Object} params.user - authenticated user (the lookup is made as them)
   * @param {string} params.baseUrl - iFinder base URL
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{ searchProfile: string|undefined, source: string }>}
   */
  async resolveSearchProfile({ profileId, configuredSearchProfile, user, baseUrl, signal }) {
    const fallback = {
      searchProfile: configuredSearchProfile || undefined,
      source: configuredSearchProfile ? 'configured' : 'none'
    };

    const { resolveSearchProfileFromProfile } = iAssistantService.getConfig();
    if (!resolveSearchProfileFromProfile || !profileId || !baseUrl) return fallback;

    try {
      const fromProfile = await this.searchProfileOf({ profileId, user, baseUrl, signal });
      if (fromProfile) return { searchProfile: fromProfile, source: 'profile' };
    } catch (error) {
      // Includes the 404 an installation returns for a profile id that only
      // exists as a workflow default, which is not worth an error line.
      logger.debug('Could not read search profile from iAssistant profile', {
        component: 'IAssistantProfileResolver',
        profileId,
        error: error?.message
      });
    }

    return fallback;
  }

  /**
   * Cached, de-duplicated read of one profile's search profile.
   *
   * Cached per (baseUrl, profileId) rather than per user: the profile is a
   * piece of installation configuration, and the value extracted from it is
   * the same whoever asks. What a given user is then allowed to retrieve under
   * that profile is decided by iFinder on every search, not here.
   *
   * @returns {Promise<string|null>}
   */
  searchProfileOf({ profileId, user, baseUrl, signal }) {
    const key = `${baseUrl}::${profileId}`;
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const { profileCacheTtlMs } = iAssistantService.getConfig();
    const lookup = conversationApiService
      .getProfile(profileId, { user, baseUrl, signal })
      .then(profile => {
        const value = extractSearchProfile(profile);
        this.cache.set(key, { value, expiresAt: Date.now() + profileCacheTtlMs });
        if (value) {
          logger.info('Search profile resolved from iAssistant profile', {
            component: 'IAssistantProfileResolver',
            profileId,
            searchProfile: value
          });
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, lookup);
    return lookup;
  }
}

/**
 * Pull a search profile out of a profile payload, looking in every place one
 * could reasonably be published: on the profile itself, on its retrieval
 * scope, and in the workflow configuration's three override levels.
 *
 * @param {Object} profile - a Profile as returned by GET /v0/profiles/{id}
 * @returns {string|null} the search profile, or null when the profile has none
 */
export function extractSearchProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;

  const configuration = profile.workflow?.configuration || {};
  const states = configuration.states || {};

  const candidates = [
    profile,
    profile.retrieval_scope,
    profile.retrievalScope,
    configuration,
    configuration.workflow,
    configuration.state_defaults,
    configuration.stateDefaults,
    ...Object.values(states)
  ];

  for (const candidate of candidates) {
    const value = firstSearchProfileKey(candidate);
    if (value) return value;
  }

  return null;
}

/**
 * The first non-blank search-profile value on one object, or null.
 * @param {*} source
 * @returns {string|null}
 */
function firstSearchProfileKey(source) {
  if (!source || typeof source !== 'object') return null;
  for (const key of SEARCH_PROFILE_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export default new IAssistantProfileResolver();
