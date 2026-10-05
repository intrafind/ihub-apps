/**
 * User skills — the policy half: whether this installation lets users keep
 * their own skills, how big they may be, and whom they may share them with.
 *
 * The same model as user prompts (`services/prompts/userPromptSettings.js`),
 * gated by the `skills` feature flag instead of the prompt library: user
 * skills are runtime user data stored through the storage abstraction, and
 * the `platform.userSkills` block is where an admin switches them off, caps
 * their size and number, and narrows the audiences they may be shared with.
 *
 * @module services/skills/userSkillSettings
 */
import { isFeatureEnabled } from '../../featureRegistry.js';
import { allowedShareTargets } from '../prompts/userPromptSettings.js';

/** Feature flag gating skills, global and user skills alike. */
export const SKILLS_FEATURE = 'skills';

/** Built-in `platform.userSkills` values. */
export const DEFAULT_USER_SKILL_SETTINGS = Object.freeze({
  enabled: true,
  maxSkillsPerUser: 50,
  maxVersions: 50,
  maxSkillSizeKB: 256,
  maxFilesPerSkill: 20,
  sharing: Object.freeze({
    allowUsers: true,
    allowGroups: true,
    allowEveryone: true,
    restrictToGroups: Object.freeze([])
  })
});

/** Most share targets one skill may carry. */
export const MAX_SHARE_TARGETS = 100;

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A positive whole number, or the fallback for anything else. */
function readPositive(value, fallback) {
  const parsed = readNumber(value, fallback);
  return parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * The effective `platform.userSkills` block, every key present.
 *
 * `maxSkillsPerUser` of zero or less means no limit, as for every other cap
 * on the platform. The size, file and version limits always apply: zero or
 * less falls back to the default rather than switching the limit off.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {{enabled: boolean, maxSkillsPerUser: number, maxVersions: number,
 *   maxSkillSizeKB: number, maxFilesPerSkill: number,
 *   sharing: {allowUsers: boolean, allowGroups: boolean, allowEveryone: boolean,
 *   restrictToGroups: string[]}}}
 */
export function userSkillSettings(platformConfig) {
  const block = platformConfig?.userSkills || {};
  const sharing = block.sharing || {};
  const defaults = DEFAULT_USER_SKILL_SETTINGS;
  return {
    enabled: readBoolean(block.enabled, defaults.enabled),
    maxSkillsPerUser: Math.max(
      0,
      Math.floor(readNumber(block.maxSkillsPerUser, defaults.maxSkillsPerUser))
    ),
    maxVersions: readPositive(block.maxVersions, defaults.maxVersions),
    maxSkillSizeKB: readPositive(block.maxSkillSizeKB, defaults.maxSkillSizeKB),
    maxFilesPerSkill: readPositive(block.maxFilesPerSkill, defaults.maxFilesPerSkill),
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
 * Whether user skills are switched on: the skills feature is on and the admin
 * has not switched user skills off. Storage availability is the repository's
 * to answer.
 *
 * @param {Object} featureConfig - Saved feature flags.
 * @param {Object} platformConfig - Platform configuration.
 * @returns {boolean}
 */
export function isUserSkillsConfigured(featureConfig = {}, platformConfig = {}) {
  if (!isFeatureEnabled(SKILLS_FEATURE, featureConfig)) return false;
  return userSkillSettings(platformConfig).enabled !== false;
}

/**
 * The audiences one user may share a skill with right now.
 *
 * @param {ReturnType<typeof userSkillSettings>} settings - Effective settings.
 * @param {string[]} effectiveGroups - The user's groups, inheritance resolved.
 * @returns {{user: boolean, group: boolean, everyone: boolean}}
 */
export function allowedSkillShareTargets(settings, effectiveGroups = []) {
  return allowedShareTargets(settings, effectiveGroups);
}

/**
 * What `GET /api/configs/platform` tells the client about user skills. The
 * server enforces every rule on write; this only lets the UI hide what would
 * be refused.
 *
 * @param {Object} featureConfig - Saved feature flags.
 * @param {Object} platformConfig - Platform configuration.
 * @param {Object} [options]
 * @param {boolean} [options.storageAvailable=false] - Whether the repository can store.
 * @returns {{enabled: boolean, maxSkillsPerUser: number, maxSkillSizeKB: number,
 *   maxFilesPerSkill: number, sharing: {allowUsers: boolean, allowGroups: boolean,
 *   allowEveryone: boolean, restricted: boolean}}}
 */
export function userSkillsClientConfig(
  featureConfig = {},
  platformConfig = {},
  { storageAvailable = false } = {}
) {
  const settings = userSkillSettings(platformConfig);
  return {
    enabled: storageAvailable && isUserSkillsConfigured(featureConfig, platformConfig),
    maxSkillsPerUser: settings.maxSkillsPerUser,
    maxSkillSizeKB: settings.maxSkillSizeKB,
    maxFilesPerSkill: settings.maxFilesPerSkill,
    sharing: {
      allowUsers: settings.sharing.allowUsers,
      allowGroups: settings.sharing.allowGroups,
      allowEveryone: settings.sharing.allowEveryone,
      restricted: settings.sharing.restrictToGroups.length > 0
    }
  };
}
