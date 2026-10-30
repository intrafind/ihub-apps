// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Projects — the policy half: whether this installation offers projects,
 * which tier backs them, the limits of the local tier and whom a user may
 * share a project with.
 *
 * Two feature flags sit above the `platform.projects` block:
 *
 *  - `projects` gates the admin pages, the admin API, the picker endpoints
 *    and every project at runtime: with it off, no project (admin or user)
 *    reaches a chat's knowledge scope or the `project` source provider.
 *  - `userProjects` gates projects users create themselves: the project
 *    pages, the chat-input picker and container-first chats. It is the phase
 *    1 feature flag of #1036 and ships off.
 *
 * See `concepts/projects/2026-10-20 Spec 1 …` §7.3.
 *
 * @module services/projects/projectSettings
 */
import { isFeatureEnabled } from '../../featureRegistry.js';

// The per-app switches live in shared/ so the browser reads them alike.
export { appAllowsUserProjects, appUsesProjects } from '../../../shared/appProjects.js';

/** Feature flag gating all projects, the admin pages and the picker endpoints. */
export const PROJECTS_FEATURE = 'projects';

/** Feature flag gating projects users create themselves. */
export const USER_PROJECTS_FEATURE = 'userProjects';

import {
  MAX_FILES_CEILING,
  MAX_MEMBERS,
  PROJECT_TIERS,
  TIER_POLICIES
} from './projectConstants.js';

export { MAX_FILES_CEILING, MAX_MEMBERS, PROJECT_TIERS, TIER_POLICIES };

/** Built-in `platform.projects` values. */
export const DEFAULT_PROJECT_SETTINGS = Object.freeze({
  tierPolicy: 'ihub',
  limits: Object.freeze({
    maxFiles: 25,
    maxFileBytes: 20 * 1024 * 1024,
    maxProjectBytes: 200 * 1024 * 1024,
    maxProjectsPerUser: 20
  }),
  sharing: Object.freeze({
    allowUsers: true,
    allowGroups: true,
    allowEveryone: false,
    allowCatalog: false
  }),
  retentionDays: 0,
  loadAllMaxTokens: 50000,
  kinds: Object.freeze({}),
  encryption: Object.freeze({ keyProvider: 'local-file' }),
  scan: Object.freeze({ provider: 'none', command: '', timeoutMs: 30000, onError: 'reject' }),
  ingest: Object.freeze({ concurrency: 2, staleAfterMinutes: 30 })
});

/** Malware scan providers phase 1 ships. */
export const SCAN_PROVIDERS = Object.freeze(['none', 'command']);

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readPositive(value, fallback) {
  const parsed = readNumber(value, fallback);
  return parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * The effective `platform.projects` block, every key present and every
 * number inside its bounds.
 *
 * `limits.maxFiles` is clamped to the hard ceiling; `maxProjectsPerUser` of
 * zero or less means no cap, the way every other cap on the platform works;
 * `retentionDays` of zero or less keeps user projects until deleted.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {{tierPolicy: string, limits: {maxFiles: number, maxFileBytes: number,
 *   maxProjectBytes: number, maxProjectsPerUser: number}, sharing: {allowUsers: boolean,
 *   allowGroups: boolean, allowEveryone: boolean, allowCatalog: boolean}, retentionDays: number,
 *   loadAllMaxTokens: number, kinds: Object<string, boolean>, encryption: {keyProvider: string},
 *   scan: {provider: string, command: string, timeoutMs: number, onError: string},
 *   ingest: {concurrency: number, staleAfterMinutes: number}}}
 */
export function projectSettings(platformConfig) {
  const block = platformConfig?.projects || {};
  const limits = block.limits || {};
  const sharing = block.sharing || {};
  const defaults = DEFAULT_PROJECT_SETTINGS;
  const tierPolicy = TIER_POLICIES.includes(block.tierPolicy)
    ? block.tierPolicy
    : defaults.tierPolicy;
  return {
    tierPolicy,
    limits: {
      maxFiles: Math.min(
        MAX_FILES_CEILING,
        readPositive(limits.maxFiles, defaults.limits.maxFiles)
      ),
      maxFileBytes: readPositive(limits.maxFileBytes, defaults.limits.maxFileBytes),
      maxProjectBytes: readPositive(limits.maxProjectBytes, defaults.limits.maxProjectBytes),
      maxProjectsPerUser: Math.max(
        0,
        Math.floor(readNumber(limits.maxProjectsPerUser, defaults.limits.maxProjectsPerUser))
      )
    },
    sharing: {
      allowUsers: readBoolean(sharing.allowUsers, defaults.sharing.allowUsers),
      allowGroups: readBoolean(sharing.allowGroups, defaults.sharing.allowGroups),
      allowEveryone: readBoolean(sharing.allowEveryone, defaults.sharing.allowEveryone),
      allowCatalog: readBoolean(sharing.allowCatalog, defaults.sharing.allowCatalog)
    },
    retentionDays: Math.max(0, Math.floor(readNumber(block.retentionDays, defaults.retentionDays))),
    loadAllMaxTokens: readPositive(block.loadAllMaxTokens, defaults.loadAllMaxTokens),
    kinds:
      block.kinds && typeof block.kinds === 'object' && !Array.isArray(block.kinds)
        ? { ...block.kinds }
        : {},
    encryption: {
      keyProvider:
        typeof block.encryption?.keyProvider === 'string' && block.encryption.keyProvider
          ? block.encryption.keyProvider
          : defaults.encryption.keyProvider
    },
    scan: {
      provider: SCAN_PROVIDERS.includes(block.scan?.provider)
        ? block.scan.provider
        : defaults.scan.provider,
      command: typeof block.scan?.command === 'string' ? block.scan.command : defaults.scan.command,
      timeoutMs: readPositive(block.scan?.timeoutMs, defaults.scan.timeoutMs),
      onError: block.scan?.onError === 'allow' ? 'allow' : 'reject'
    },
    ingest: {
      concurrency: Math.min(
        8,
        readPositive(block.ingest?.concurrency, defaults.ingest.concurrency)
      ),
      staleAfterMinutes: readPositive(
        block.ingest?.staleAfterMinutes,
        defaults.ingest.staleAfterMinutes
      )
    }
  };
}

/**
 * Whether `platform.iFinder` points at an iFinder installation, the way the
 * iFinder item kinds read it (`kinds/linkKinds.js`).
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {boolean}
 */
export function isIFinderConfigured(platformConfig) {
  return Boolean(platformConfig?.iFinder?.baseUrl || process.env.IFINDER_API_URL);
}

/**
 * Whether the tier policy offers the user's iFinder smart collections as
 * projects (`both` or `ifinder`). Whether the installation then has iFinder
 * configured and the Smart Collections API is another question: see
 * {@link iFinderTierConfigured} and the capability call.
 *
 * @param {ReturnType<typeof projectSettings>} settings
 * @returns {boolean}
 */
export function policyOffersIFinder(settings) {
  return settings?.tierPolicy === 'both' || settings?.tierPolicy === 'ifinder';
}

/**
 * Whether the iFinder tier can be offered at all on this installation: the
 * policy says so and iFinder is configured. The per-user checks (a stable
 * principal, the capability call) come on top.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {boolean}
 */
export function iFinderTierConfigured(platformConfig) {
  return (
    policyOffersIFinder(projectSettings(platformConfig)) && isIFinderConfigured(platformConfig)
  );
}

/**
 * Whether admin projects and their pages are switched on.
 *
 * @param {Object} [featureConfig] - Saved feature flags.
 * @returns {boolean}
 */
export function isProjectsConfigured(featureConfig = {}) {
  return isFeatureEnabled(PROJECTS_FEATURE, featureConfig);
}

/**
 * Whether users may create projects of their own: both flags on. Storage
 * availability is the repository's to answer.
 *
 * @param {Object} [featureConfig] - Saved feature flags.
 * @returns {boolean}
 */
export function isUserProjectsConfigured(featureConfig = {}) {
  return (
    isProjectsConfigured(featureConfig) && isFeatureEnabled(USER_PROJECTS_FEATURE, featureConfig)
  );
}

/**
 * The `projects` block `GET /api/configs/platform` sends: what the client
 * needs to decide whether to show projects at all, and the limits the
 * dialogs display. The server enforces the same.
 *
 * @param {Object} featureConfig - Saved feature flags.
 * @param {Object} platformConfig - Platform configuration.
 * @param {Object} [options]
 * @param {boolean} [options.storageAvailable=false] - A storage provider came up.
 * @returns {Object}
 */
export function projectsClientConfig(
  featureConfig = {},
  platformConfig = {},
  { storageAvailable = false } = {}
) {
  const settings = projectSettings(platformConfig);
  const enabled = storageAvailable && isProjectsConfigured(featureConfig);
  return {
    enabled,
    userProjects: enabled && isUserProjectsConfigured(featureConfig),
    tierPolicy: settings.tierPolicy,
    // The tiers this installation shows. The local tier always stays: its
    // projects keep working under every policy, and creating projects in the
    // iFinder tier arrives with the next iteration. The iFinder tier is listed
    // when the policy offers it and iFinder is configured; whether the
    // iFinder version has the Smart Collections API is the per-user answer of
    // `GET /api/projects/_config` (`ifinder.available`).
    tiers: iFinderTierConfigured(platformConfig) ? ['ihub', 'ifinder'] : ['ihub'],
    limits: settings.limits,
    sharing: settings.sharing,
    retentionDays: settings.retentionDays
  };
}
