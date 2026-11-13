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
import { allowedKnowledgeModes } from '../../../shared/knowledgeModes.js';
import { isIFinderConfigured as iFinderInstalled } from '../integrations/ifinderConfig.js';

// The per-app switches live in shared/ so the browser reads them alike.
export { appAllowsUserProjects, appUsesProjects } from '../../../shared/appProjects.js';

/** Feature flag gating all projects, the admin pages and the picker endpoints. */
export const PROJECTS_FEATURE = 'projects';

/** Feature flag gating projects users create themselves. */
export const USER_PROJECTS_FEATURE = 'userProjects';

import {
  DEFAULT_FETCH_CONCURRENCY,
  DEFAULT_REFRESH_IDLE_DAYS,
  DEFAULT_REFRESH_MODE,
  DEFAULT_REFRESH_TTL_SECONDS,
  DEFAULT_REFRESH_WAIT_SECONDS,
  MAX_CONVERT_CONCURRENCY,
  MAX_FETCH_CONCURRENCY,
  MAX_REFRESH_WAIT_SECONDS,
  normalizeRefreshMode,
  normalizeRefreshTtl
} from './refreshTtl.js';
import {
  DEFAULT_INDEX_CACHE_ENTRIES,
  MAX_CACHE_HEAP_SHARE,
  MAX_FILES_CEILING,
  MAX_INDEX_CACHE_ENTRIES,
  MAX_MEMBERS,
  MIN_CACHE_HEAP_SHARE,
  PROJECT_TIERS,
  TIER_POLICIES
} from './projectConstants.js';

export { MAX_FILES_CEILING, MAX_MEMBERS, PROJECT_TIERS, TIER_POLICIES };

export { DEFAULT_INDEX_CACHE_ENTRIES };

/** Built-in `platform.projects` values. */
export const DEFAULT_PROJECT_SETTINGS = Object.freeze({
  tierPolicy: 'ihub',
  defaultAppId: '',
  limits: Object.freeze({
    maxFiles: 100,
    maxFileBytes: 20 * 1024 * 1024,
    maxProjectBytes: 500 * 1024 * 1024,
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
  // The knowledge modes users may choose for a project or a chat (#3538); absent offers all.
  knowledgeModes: allowedKnowledgeModes(null),
  // How long a downloaded file or a web page is taken as current (#3536):
  // seconds, or 'never'. A project and an item may set their own.
  refreshTtl: DEFAULT_REFRESH_TTL_SECONDS,
  refreshMode: DEFAULT_REFRESH_MODE,
  refreshIdleDays: DEFAULT_REFRESH_IDLE_DAYS,
  refreshWaitSeconds: DEFAULT_REFRESH_WAIT_SECONDS,
  kinds: Object.freeze({}),
  encryption: Object.freeze({ keyProvider: 'local-file' }),
  scan: Object.freeze({ provider: 'none', command: '', timeoutMs: 30000, onError: 'reject' }),
  // `concurrency`: conversions (scan and extraction) at once per server
  // process; `fetchConcurrency`: jobs at once, each fetching its source before
  // it waits for a conversion slot (#3622).
  ingest: Object.freeze({
    concurrency: 2,
    fetchConcurrency: DEFAULT_FETCH_CONCURRENCY,
    staleAfterMinutes: 30
  })
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
 * @returns {{tierPolicy: string, defaultAppId: string, limits: {maxFiles: number, maxFileBytes: number,
 *   maxProjectBytes: number, maxProjectsPerUser: number}, sharing: {allowUsers: boolean,
 *   allowGroups: boolean, allowEveryone: boolean, allowCatalog: boolean}, retentionDays: number,
 *   loadAllMaxTokens: number, knowledgeModes: string[], refreshTtl: number|'never',
 *   refreshMode: 'auto'|'onDemand', refreshIdleDays: number, kinds: Object<string, boolean>, encryption: {keyProvider: string},
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
    // The app a project chat starts in when its project names none ('' for the
    // first app the user may chat in).
    defaultAppId:
      typeof block.defaultAppId === 'string' ? block.defaultAppId.trim() : defaults.defaultAppId,
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
    knowledgeModes: allowedKnowledgeModes(block.knowledgeModes),
    refreshTtl: normalizeRefreshTtl(block.refreshTtl) ?? defaults.refreshTtl,
    refreshMode: normalizeRefreshMode(block.refreshMode) ?? defaults.refreshMode,
    // 0 turns the idle rule off: `auto` projects refresh in the background always.
    refreshIdleDays:
      Number.isInteger(block.refreshIdleDays) && block.refreshIdleDays >= 0
        ? Math.min(block.refreshIdleDays, 3650)
        : defaults.refreshIdleDays,
    // 0 does not wait: readers take the stored text and the refresh runs behind.
    refreshWaitSeconds:
      Number.isInteger(block.refreshWaitSeconds) && block.refreshWaitSeconds >= 0
        ? Math.min(block.refreshWaitSeconds, MAX_REFRESH_WAIT_SECONDS)
        : defaults.refreshWaitSeconds,
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
    ingest: ingestSettings(block.ingest, defaults.ingest),
    indexCache: {
      maxEntries: Math.min(
        MAX_INDEX_CACHE_ENTRIES,
        readPositive(block.indexCache?.maxEntries, DEFAULT_INDEX_CACHE_ENTRIES)
      ),
      maxHeapShare: readHeapShare(block.indexCache?.maxHeapShare)
    },
    textCache: { maxHeapShare: readHeapShare(block.textCache?.maxHeapShare) }
  };
}

/**
 * A configured heap share inside `[MIN_CACHE_HEAP_SHARE, MAX_CACHE_HEAP_SHARE]`,
 * or `null` when none is set (the built-in budget with its old ceiling applies).
 * A value outside the range is clamped, a non-number is ignored.
 */
function readHeapShare(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_CACHE_HEAP_SHARE, Math.max(MIN_CACHE_HEAP_SHARE, parsed));
}

/**
 * The `ingest` block: conversions at once, and jobs at once (each fetching
 * before it waits for a conversion), never fewer jobs than conversions.
 */
function ingestSettings(block, defaults) {
  const concurrency = Math.min(
    MAX_CONVERT_CONCURRENCY,
    readPositive(block?.concurrency, defaults.concurrency)
  );
  return {
    concurrency,
    fetchConcurrency: Math.max(
      concurrency,
      Math.min(
        MAX_FETCH_CONCURRENCY,
        readPositive(block?.fetchConcurrency, defaults.fetchConcurrency)
      )
    ),
    staleAfterMinutes: readPositive(block?.staleAfterMinutes, defaults.staleAfterMinutes)
  };
}

/**
 * Whether the iFinder installation (Admin → Integrations → Installed) is on
 * and points at an iFinder, the way the iFinder item kinds read it
 * (`kinds/linkKinds.js`). The platform config is no longer consulted; the
 * parameter stays so callers that pass it keep working.
 *
 * @returns {boolean}
 */
export function isIFinderConfigured() {
  return iFinderInstalled();
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
  return policyOffersIFinder(projectSettings(platformConfig)) && isIFinderConfigured();
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
    defaultAppId: settings.defaultAppId,
    limits: settings.limits,
    sharing: settings.sharing,
    retentionDays: settings.retentionDays,
    knowledgeModes: settings.knowledgeModes,
    refreshTtl: settings.refreshTtl,
    refreshMode: settings.refreshMode
  };
}
