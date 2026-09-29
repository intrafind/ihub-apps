/**
 * User prompts — the policy half: whether this installation lets users keep
 * their own prompts, and whom they may share them with.
 *
 * User prompts are runtime user data, stored through the storage abstraction,
 * so nothing here answers "yes" unless a storage provider came up. On top of
 * that sit the `promptsLibrary` feature flag (the library as a whole) and the
 * `platform.userPrompts` block, which is where an admin switches user prompts
 * off, narrows the audiences a prompt may be shared with and caps how many
 * prompts one user may keep.
 *
 * @module services/prompts/userPromptSettings
 */
import { isFeatureEnabled } from '../../featureRegistry.js';

/** Feature flag gating the prompt library, global and user prompts alike. */
export const PROMPTS_LIBRARY_FEATURE = 'promptsLibrary';

/** Built-in `platform.userPrompts` values. */
export const DEFAULT_USER_PROMPT_SETTINGS = Object.freeze({
  enabled: true,
  maxPromptsPerUser: 0,
  maxVersions: 50,
  sharing: Object.freeze({
    allowUsers: true,
    allowGroups: true,
    allowEveryone: true,
    restrictToGroups: Object.freeze([])
  })
});

/** Most share targets one prompt may carry. */
export const MAX_SHARE_TARGETS = 100;

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The effective `platform.userPrompts` block, every key present.
 *
 * Numbers of zero or less switch a cap off, the way every other cap on the
 * platform works: `maxPromptsPerUser: 0` means no limit. `maxVersions` is the
 * exception in one direction only — history is always kept, so zero or less
 * falls back to the default rather than keeping none.
 *
 * `sharing.restrictToGroups` narrows who may share with groups or with
 * everyone: when it names groups, only their members (inheritance resolved)
 * may pick those audiences. Sharing with named users stays open to everyone,
 * the same as handing a colleague a copy.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {{enabled: boolean, maxPromptsPerUser: number, maxVersions: number,
 *   sharing: {allowUsers: boolean, allowGroups: boolean, allowEveryone: boolean,
 *   restrictToGroups: string[]}}}
 */
export function userPromptSettings(platformConfig) {
  const block = platformConfig?.userPrompts || {};
  const sharing = block.sharing || {};
  const defaults = DEFAULT_USER_PROMPT_SETTINGS;
  const maxVersions = readNumber(block.maxVersions, defaults.maxVersions);
  return {
    enabled: readBoolean(block.enabled, defaults.enabled),
    maxPromptsPerUser: Math.max(0, readNumber(block.maxPromptsPerUser, 0)),
    maxVersions: maxVersions > 0 ? Math.floor(maxVersions) : defaults.maxVersions,
    sharing: {
      allowUsers: readBoolean(sharing.allowUsers, defaults.sharing.allowUsers),
      allowGroups: readBoolean(sharing.allowGroups, defaults.sharing.allowGroups),
      allowEveryone: readBoolean(sharing.allowEveryone, defaults.sharing.allowEveryone),
      restrictToGroups: Array.isArray(sharing.restrictToGroups)
        ? sharing.restrictToGroups.filter(group => typeof group === 'string' && group)
        : []
    }
  };
}

/**
 * Whether user prompts are switched on: the prompt library is on and the
 * admin has not switched user prompts off. Storage availability is the
 * repository's to answer.
 *
 * @param {Object} featureConfig - Saved feature flags.
 * @param {Object} platformConfig - Platform configuration.
 * @returns {boolean}
 */
export function isUserPromptsConfigured(featureConfig = {}, platformConfig = {}) {
  if (!isFeatureEnabled(PROMPTS_LIBRARY_FEATURE, featureConfig)) return false;
  return userPromptSettings(platformConfig).enabled !== false;
}

/**
 * Whether a user may share with groups or with everyone, given the admin's
 * `restrictToGroups`.
 *
 * @param {ReturnType<typeof userPromptSettings>} settings - Effective settings.
 * @param {string[]} effectiveGroups - The user's groups, inheritance resolved.
 * @returns {boolean}
 */
export function mayShareBroadly(settings, effectiveGroups = []) {
  const restricted = settings.sharing.restrictToGroups;
  if (!restricted.length) return true;
  return restricted.some(group => effectiveGroups.includes(group));
}

/**
 * The audiences one user may pick right now.
 *
 * @param {ReturnType<typeof userPromptSettings>} settings - Effective settings.
 * @param {string[]} effectiveGroups - The user's groups, inheritance resolved.
 * @returns {{user: boolean, group: boolean, everyone: boolean}}
 */
export function allowedShareTargets(settings, effectiveGroups = []) {
  const broad = mayShareBroadly(settings, effectiveGroups);
  return {
    user: settings.sharing.allowUsers !== false,
    group: settings.sharing.allowGroups !== false && broad,
    everyone: settings.sharing.allowEveryone !== false && broad
  };
}

/**
 * What `GET /api/configs/platform` tells the client about user prompts. The
 * server enforces every rule on write; this only lets the UI hide what would
 * be refused. `available` folds in the storage provider, which the settings
 * block cannot know about.
 *
 * @param {Object} featureConfig - Saved feature flags.
 * @param {Object} platformConfig - Platform configuration.
 * @param {Object} [options]
 * @param {boolean} [options.storageAvailable=false] - Whether the repository can store.
 * @returns {{enabled: boolean, maxPromptsPerUser: number,
 *   sharing: {allowUsers: boolean, allowGroups: boolean, allowEveryone: boolean,
 *   restricted: boolean}}}
 */
export function userPromptsClientConfig(
  featureConfig = {},
  platformConfig = {},
  { storageAvailable = false } = {}
) {
  const settings = userPromptSettings(platformConfig);
  return {
    enabled: storageAvailable && isUserPromptsConfigured(featureConfig, platformConfig),
    maxPromptsPerUser: settings.maxPromptsPerUser,
    sharing: {
      allowUsers: settings.sharing.allowUsers,
      allowGroups: settings.sharing.allowGroups,
      allowEveryone: settings.sharing.allowEveryone,
      // Whether group and everyone shares are limited to some groups; the
      // per-user answer comes with the share-target lookup.
      restricted: settings.sharing.restrictToGroups.length > 0
    }
  };
}
