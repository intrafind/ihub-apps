// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Personal apps — the policy half: whether this installation offers them, the
 * limits, whom a user may share an app with, whether owners may publish, and
 * what a personal app may use at all.
 *
 * One feature flag sits above the `platform.userApps` block: `userApps`, a
 * preview that ships off. The block is read on every request, so a change by
 * an admin applies without a restart.
 *
 * The parts `limits` and `sharing` have the keys and the defaults of
 * `platform.projects` (`services/projects/projectSettings.js`); a test
 * compares the two, so they cannot drift apart unnoticed.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 3.1 and 4.5.
 *
 * @module services/userApps/userAppSettings
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import { USER_APP_LIMITS, isUserAppId } from '../../../shared/userAppContent.js';
import { ADMIN_ENABLES_VALUES, FORBIDDEN_INSTALLATION_ID } from '../../validators/userAppSchema.js';

const COMPONENT = 'UserApps';

/** Feature flag gating personal apps. */
export const USER_APPS_FEATURE = 'userApps';

// `ihub` owns `ask_user` and the scheduling tools and is never on the list;
// `withTools` is the first value of `publishing.adminEnables` and its default.
export { ADMIN_ENABLES_VALUES, FORBIDDEN_INSTALLATION_ID };

/** The app ID that the client route `/apps/new` shadows while the feature is on. */
const SHADOWED_APP_ID = 'new';

/** Built-in `platform.userApps` values. */
export const DEFAULT_USER_APP_SETTINGS = Object.freeze({
  limits: Object.freeze({
    maxAppsPerUser: 20,
    maxOpenOffersPerUser: 5,
    ownerSnapshotMaxAgeDays: 30
  }),
  sharing: Object.freeze({
    allowUsers: true,
    allowGroups: true,
    allowEveryone: false,
    allowPublish: false
  }),
  capabilities: Object.freeze({
    modelChoice: true,
    upload: true,
    webSearch: false,
    skills: false,
    integrations: Object.freeze([]),
    // How far web search may be tuned in an app of one person: the most pages the
    // page reader may open for one answer (the platform default is 5).
    webSearchLimits: Object.freeze({ maxPageReads: 10 })
  }),
  publishing: Object.freeze({ adminEnables: 'withTools' }),
  blockedOwners: Object.freeze([])
});

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A whole number of zero or more; zero means "no limit". */
function readLimit(value, fallback) {
  return Math.max(0, Math.floor(readNumber(value, fallback)));
}

/** A whole number of one or more. */
function readPositive(value, fallback) {
  const parsed = Math.floor(readNumber(value, fallback));
  return parsed > 0 ? parsed : fallback;
}

function readStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(entry => typeof entry === 'string' && entry !== ''))];
}

/**
 * The installations personal apps may bind, each with its named actions. An
 * entry without an ID, without actions, for the installation `ihub`, or a
 * repeated one is left out: what the stored block says wrongly grants nothing.
 */
function readInstallations(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!id || id === FORBIDDEN_INSTALLATION_ID || seen.has(id)) continue;
    const actions = readStrings(entry.actions).filter(action => action !== '*');
    if (actions.length === 0) continue;
    seen.add(id);
    result.push({ id, actions });
  }
  return result;
}

/**
 * The effective `platform.userApps` block, every key present.
 *
 * `limits.maxAppsPerUser` of zero or less means no limit, as
 * `maxProjectsPerUser`. `limits.ownerSnapshotMaxAgeDays` of zero never
 * distrusts an owner's stored groups. An unknown value of
 * `publishing.adminEnables` reads as `withTools`.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {{limits: {maxAppsPerUser: number, maxOpenOffersPerUser: number,
 *   ownerSnapshotMaxAgeDays: number}, sharing: {allowUsers: boolean, allowGroups: boolean,
 *   allowEveryone: boolean, allowPublish: boolean}, capabilities: {modelChoice: boolean,
 *   upload: boolean, webSearch: boolean, skills: boolean,
 *   integrations: Array<{id: string, actions: string[]}>,
 *   webSearchLimits: {maxPageReads: number}},
 *   publishing: {adminEnables: 'withTools'|'always'}, blockedOwners: string[]}}
 */
export function userAppSettings(platformConfig) {
  const block = platformConfig?.userApps || {};
  const limits = block.limits || {};
  const sharing = block.sharing || {};
  const capabilities = block.capabilities || {};
  const defaults = DEFAULT_USER_APP_SETTINGS;
  return {
    limits: {
      maxAppsPerUser: readLimit(limits.maxAppsPerUser, defaults.limits.maxAppsPerUser),
      maxOpenOffersPerUser: readPositive(
        limits.maxOpenOffersPerUser,
        defaults.limits.maxOpenOffersPerUser
      ),
      ownerSnapshotMaxAgeDays: readLimit(
        limits.ownerSnapshotMaxAgeDays,
        defaults.limits.ownerSnapshotMaxAgeDays
      )
    },
    sharing: {
      allowUsers: readBoolean(sharing.allowUsers, defaults.sharing.allowUsers),
      allowGroups: readBoolean(sharing.allowGroups, defaults.sharing.allowGroups),
      allowEveryone: readBoolean(sharing.allowEveryone, defaults.sharing.allowEveryone),
      allowPublish: readBoolean(sharing.allowPublish, defaults.sharing.allowPublish)
    },
    capabilities: {
      modelChoice: readBoolean(capabilities.modelChoice, defaults.capabilities.modelChoice),
      upload: readBoolean(capabilities.upload, defaults.capabilities.upload),
      webSearch: readBoolean(capabilities.webSearch, defaults.capabilities.webSearch),
      skills: readBoolean(capabilities.skills, defaults.capabilities.skills),
      integrations: readInstallations(capabilities.integrations),
      webSearchLimits: {
        maxPageReads: Math.min(
          USER_APP_LIMITS.pageReads,
          readPositive(
            capabilities.webSearchLimits?.maxPageReads,
            defaults.capabilities.webSearchLimits.maxPageReads
          )
        )
      }
    },
    publishing: {
      adminEnables: ADMIN_ENABLES_VALUES.includes(block.publishing?.adminEnables)
        ? block.publishing.adminEnables
        : defaults.publishing.adminEnables
    },
    blockedOwners: readStrings(block.blockedOwners)
  };
}

/**
 * The settings of this installation, read from the config cache.
 *
 * @returns {ReturnType<typeof userAppSettings>}
 */
export function currentUserAppSettings() {
  return userAppSettings(configCache.getPlatform() || {});
}

/**
 * Whether personal apps are switched on. Storage availability is the
 * repository's to answer.
 *
 * @param {Object} [featureConfig] - Saved feature flags; the cached ones when omitted.
 * @returns {boolean}
 */
export function isUserAppsEnabled(featureConfig) {
  return isFeatureEnabled(USER_APPS_FEATURE, featureConfig ?? configCache.getFeatures() ?? {});
}

/**
 * Whether an admin stopped all apps of this person.
 *
 * @param {ReturnType<typeof userAppSettings>} settings
 * @param {string|number|null|undefined} userId
 * @returns {boolean}
 */
export function isBlockedOwner(settings, userId) {
  if (userId === null || userId === undefined || userId === '') return false;
  return (settings?.blockedOwners || []).includes(String(userId));
}

/**
 * The audiences a member list may name right now, in the shape
 * `resolveShares` of the prompt library takes.
 *
 * @param {ReturnType<typeof userAppSettings>} settings
 * @returns {{user: boolean, group: boolean, everyone: boolean}}
 */
export function allowedUserAppShareTargets(settings) {
  return {
    user: settings?.sharing?.allowUsers === true,
    group: settings?.sharing?.allowGroups === true,
    everyone: settings?.sharing?.allowEveryone === true
  };
}

/**
 * The actions personal apps may bind on one installation.
 *
 * @param {ReturnType<typeof userAppSettings>} settings
 * @param {string} installationId
 * @returns {string[]|null} The action names, or null when the installation is not allowed.
 */
export function allowedInstallationActions(settings, installationId) {
  const entry = (settings?.capabilities?.integrations || []).find(
    installation => installation.id === installationId
  );
  return entry ? [...entry.actions] : null;
}

/**
 * The stored `platform.userApps` block after a settings change: only the keys
 * the body sends are written, key by key inside `limits`, `sharing`,
 * `capabilities` and `publishing`; the two lists are replaced as a whole.
 * Keys the block holds beyond these stay as they are.
 *
 * The body is what `userAppSettingsSchema` (`validators/userAppSchema.js`)
 * parsed, so it holds no unknown key.
 *
 * @param {Object|undefined} stored - `platform.userApps` as stored.
 * @param {Object} body - The parsed body of `PUT /api/admin/user-apps/_settings`.
 * @returns {Object} A new block; `stored` is not modified.
 *
 * @example
 * mergeUserAppSettings({ sharing: { allowUsers: true } }, { sharing: { allowPublish: true } });
 * // → { sharing: { allowUsers: true, allowPublish: true } }
 */
export function mergeUserAppSettings(stored, body = {}) {
  const current = stored && typeof stored === 'object' ? stored : {};
  const next = { ...current };
  for (const part of ['limits', 'sharing', 'capabilities', 'publishing']) {
    if (body[part]) next[part] = { ...(current[part] || {}), ...body[part] };
  }
  if (body.blockedOwners) next.blockedOwners = [...body.blockedOwners];
  return next;
}

/**
 * The keys a settings change touched, as `part.key`, for the audit entry.
 *
 * @param {Object} body - The parsed body.
 * @returns {string[]}
 */
export function changedUserAppSettingKeys(body = {}) {
  const keys = [];
  for (const part of ['limits', 'sharing', 'capabilities', 'publishing']) {
    for (const key of Object.keys(body[part] || {})) keys.push(`${part}.${key}`);
  }
  if (body.blockedOwners) keys.push('blockedOwners');
  return keys;
}

/**
 * The `userApps` block of `GET /api/apps/_config` that does not depend on the
 * caller's apps: what the client needs to show or hide controls. The server
 * enforces the same.
 *
 * @param {ReturnType<typeof userAppSettings>} settings
 * @returns {{maxApps: number, sharing: {allowUsers: boolean, allowGroups: boolean,
 *   allowEveryone: boolean, allowPublish: boolean}, capabilities: Object}}
 */
export function userAppsClientSettings(settings) {
  return {
    maxApps: settings.limits.maxAppsPerUser,
    sharing: { ...settings.sharing },
    capabilities: {
      modelChoice: settings.capabilities.modelChoice,
      upload: settings.capabilities.upload,
      webSearch: settings.capabilities.webSearch,
      skills: settings.capabilities.skills,
      integrations: settings.capabilities.integrations.map(installation => ({
        id: installation.id,
        actions: [...installation.actions]
      }))
    }
  };
}

/**
 * What an admin should know at start-up, as a list of findings.
 *
 * - A config app whose ID has the shape of a personal app. No write path
 *   creates one, so the file was placed by hand or by a config import. It
 *   works as an admin app until a personal app gets the same ID; then both
 *   answer 404.
 * - An app with the ID `new` while the feature is on: `/apps/new` opens the
 *   create page for people who may create personal apps.
 *
 * @param {Object} [options]
 * @param {Array<{id: string}>} [options.apps] - Every config app, disabled ones included.
 * @param {boolean} [options.enabled] - Whether the feature is on.
 * @returns {Array<{code: 'PERSONAL_SHAPED_APP_ID'|'APP_ID_NEW_SHADOWED', appId: string,
 *   message: string}>}
 */
export function userAppWarnings({ apps = [], enabled = false } = {}) {
  const findings = [];
  for (const app of apps) {
    const appId = typeof app?.id === 'string' ? app.id : '';
    if (isUserAppId(appId)) {
      findings.push({
        code: 'PERSONAL_SHAPED_APP_ID',
        appId,
        message:
          `The app "${appId}" has an ID of the shape reserved for personal apps. ` +
          'Rename the file: if a personal app ever gets the same ID, both stop answering.'
      });
    }
    if (enabled && appId === SHADOWED_APP_ID) {
      findings.push({
        code: 'APP_ID_NEW_SHADOWED',
        appId,
        message:
          'An app has the ID "new". With personal apps switched on, /apps/new opens the ' +
          'create page for everyone who may create personal apps. Give the app another ID.'
      });
    }
  }
  return findings;
}

/**
 * Log the findings of {@link userAppWarnings} for this installation. Called
 * once when the personal app routes are registered; never throws.
 *
 * @param {Object} [options]
 * @param {Object} [options.log] - Logger; defaults to the shared one.
 * @returns {ReturnType<typeof userAppWarnings>} What was logged.
 */
export function logUserAppWarnings({ log = logger } = {}) {
  let findings = [];
  try {
    findings = userAppWarnings({
      apps: configCache.getApps(true)?.data || [],
      enabled: isUserAppsEnabled()
    });
  } catch (error) {
    log.warn('Could not check the apps for personal app ID clashes', {
      component: COMPONENT,
      error: error.message
    });
    return [];
  }
  for (const finding of findings) {
    log.warn(finding.message, { component: COMPONENT, code: finding.code, appId: finding.appId });
  }
  return findings;
}
