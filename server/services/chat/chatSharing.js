/**
 * Chat sharing — the policy half: which modes an installation allows, what an
 * owner may pick for a link, and what state a share is in right now.
 *
 * Sharing rides on durable chats: a share is a frozen copy of a stored
 * transcript, so nothing here answers "yes" unless
 * `chatPersistence.isChatPersistenceConfigured` does too. On top of that sit
 * the `chatSharing` feature flag and the `platform.chats.sharing` block, which
 * is where an admin switches individual modes off (public links most often)
 * and caps what a link may be configured with.
 *
 * @module services/chat/chatSharing
 */
import { isFeatureEnabled } from '../../featureRegistry.js';
import { isChatPersistenceConfigured } from './chatPersistence.js';

/** Feature flag gating chat sharing as a whole. */
export const CHAT_SHARING_FEATURE = 'chatSharing';

/**
 * The three ways a link can be addressed.
 *
 * - `users`: only the users the owner picked from the user database.
 * - `authenticated`: anyone signed in to this installation who has the link.
 * - `public`: anyone who has the link, no sign-in.
 */
export const SHARE_MODES = Object.freeze(['users', 'authenticated', 'public']);

/** Most recipients one `users` share may name. */
export const MAX_SHARE_RECIPIENTS = 50;

/** Built-in `platform.chats.sharing` values. */
export const DEFAULT_SHARING_SETTINGS = Object.freeze({
  enabled: true,
  allowUsers: true,
  allowAuthenticated: true,
  allowPublic: true,
  defaultExpiryDays: 0,
  maxExpiryDays: 0,
  maxViewsCap: 0
});

/** One day in milliseconds, for turning the day-based caps into instants. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a counted open the artifacts of a share that has just
 * reached its view limit may still be fetched.
 *
 * The open that uses the last view is served, and the page then fetches the
 * images and files that transcript names — each its own request, none of
 * them a view. Without this window those follow-up requests would find the
 * share exhausted and the last allowed viewer would see broken pictures.
 */
export const SHARE_ARTIFACT_GRACE_MS = 10 * 60 * 1000;

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * The effective `platform.chats.sharing` block, every key present.
 *
 * Numbers of zero or less switch the rule off, the way every other cap under
 * `platform.chats` works: `defaultExpiryDays: 0` means a new link does not
 * expire unless the owner says so, `maxExpiryDays: 0` lets an owner pick any
 * expiry (or none), `maxViewsCap: 0` lets an owner leave the view limit off.
 *
 * @param {Object} [platformConfig] - Platform configuration.
 * @returns {{enabled: boolean, allowUsers: boolean, allowAuthenticated: boolean,
 *   allowPublic: boolean, defaultExpiryDays: number, maxExpiryDays: number,
 *   maxViewsCap: number}}
 */
export function chatSharingSettings(platformConfig) {
  const block = platformConfig?.chats?.sharing || {};
  return {
    enabled: readBoolean(block.enabled, DEFAULT_SHARING_SETTINGS.enabled),
    allowUsers: readBoolean(block.allowUsers, DEFAULT_SHARING_SETTINGS.allowUsers),
    allowAuthenticated: readBoolean(
      block.allowAuthenticated,
      DEFAULT_SHARING_SETTINGS.allowAuthenticated
    ),
    allowPublic: readBoolean(block.allowPublic, DEFAULT_SHARING_SETTINGS.allowPublic),
    defaultExpiryDays: readNumber(
      block.defaultExpiryDays,
      DEFAULT_SHARING_SETTINGS.defaultExpiryDays
    ),
    maxExpiryDays: readNumber(block.maxExpiryDays, DEFAULT_SHARING_SETTINGS.maxExpiryDays),
    maxViewsCap: readNumber(block.maxViewsCap, DEFAULT_SHARING_SETTINGS.maxViewsCap)
  };
}

/**
 * Whether this installation shares chats at all: durable chats are on, the
 * `chatSharing` flag is on, and the admin has not switched the block off.
 *
 * @param {Object} featureConfig - Saved feature flags.
 * @param {Object} platformConfig - Platform configuration.
 * @returns {boolean}
 */
export function isChatSharingConfigured(featureConfig = {}, platformConfig = {}) {
  if (!isChatPersistenceConfigured(featureConfig, platformConfig)) return false;
  if (!isFeatureEnabled(CHAT_SHARING_FEATURE, featureConfig)) return false;
  return chatSharingSettings(platformConfig).enabled !== false;
}

/**
 * The modes an owner may currently pick, from the settings block.
 *
 * @param {ReturnType<typeof chatSharingSettings>} settings - Effective settings.
 * @returns {{users: boolean, authenticated: boolean, public: boolean}}
 */
export function allowedShareModes(settings) {
  return {
    users: settings.allowUsers !== false,
    authenticated: settings.allowAuthenticated !== false,
    public: settings.allowPublic !== false
  };
}

/**
 * What `GET /api/configs/platform` tells the client about sharing: whether
 * it is on, which modes are offered and the caps the form has to respect.
 * The server enforces the same caps on create; this only lets the form hide
 * what would be refused.
 *
 * @param {Object} featureConfig - Saved feature flags.
 * @param {Object} platformConfig - Platform configuration.
 * @returns {Object}
 */
export function chatSharingClientConfig(featureConfig = {}, platformConfig = {}) {
  const settings = chatSharingSettings(platformConfig);
  return {
    enabled: isChatSharingConfigured(featureConfig, platformConfig),
    modes: allowedShareModes(settings),
    defaultExpiryDays: effectiveDefaultExpiryDays(settings),
    maxExpiryDays: settings.maxExpiryDays,
    maxViewsCap: settings.maxViewsCap,
    // In pseudonymized identity mode a share never carries its owner's name,
    // so the form has no "show my name" to offer.
    ownerNameHidden: platformConfig?.runLog?.identityMode === 'pseudonymized'
  };
}

/**
 * The state a share is in: whether its link still opens, and if not, why.
 *
 * Every non-active state answers the same 404 to a viewer — a revoked link
 * must not confirm that it once existed — but the owner's list and the admin
 * page show the reason.
 *
 * @param {Object|null} share - Share document.
 * @param {number} [now] - Clock, for tests.
 * @returns {'missing'|'active'|'revoked'|'expired'|'exhausted'}
 */
export function shareState(share, now = Date.now()) {
  if (!share) return 'missing';
  if (share.revokedAt) return 'revoked';
  if (share.expiresAt) {
    const expiresAt = Date.parse(share.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) return 'expired';
  }
  const maxViews = Number(share.maxViews);
  if (maxViews > 0 && Number(share.viewCount || 0) >= maxViews) return 'exhausted';
  return 'active';
}

/**
 * Whether a share's link opens right now.
 *
 * @param {Object|null} share - Share document.
 * @param {number} [now] - Clock, for tests.
 * @returns {boolean}
 */
export function isShareActive(share, now = Date.now()) {
  return shareState(share, now) === 'active';
}

/**
 * Whether a share that has just reached its view limit is still within the
 * window in which its artifacts may be fetched — see
 * {@link SHARE_ARTIFACT_GRACE_MS}. Revoked and expired shares never are.
 *
 * @param {Object|null} share - Share document.
 * @param {number} [now] - Clock, for tests.
 * @returns {boolean}
 */
export function isWithinArtifactGrace(share, now = Date.now()) {
  if (shareState(share, now) !== 'exhausted') return false;
  const lastViewedAt = Date.parse(share.lastViewedAt || '');
  return Number.isFinite(lastViewedAt) && now - lastViewedAt <= SHARE_ARTIFACT_GRACE_MS;
}

/**
 * The default expiry an owner gets when they pick none, never longer than the
 * longest expiry they may pick: an admin who sets the default above the cap
 * gets the cap, not a form every owner is refused on.
 *
 * @param {ReturnType<typeof chatSharingSettings>} settings - Effective settings.
 * @returns {number} Days; `0` for none.
 */
export function effectiveDefaultExpiryDays(settings) {
  const fallback = settings.defaultExpiryDays > 0 ? settings.defaultExpiryDays : 0;
  if (settings.maxExpiryDays > 0)
    return Math.min(fallback || settings.maxExpiryDays, settings.maxExpiryDays);
  return fallback;
}

/**
 * Check an owner's requested expiry and view limit against the admin caps,
 * filling in the default expiry when the owner named none.
 *
 * @param {Object} requested
 * @param {string|null|undefined} requested.expiresAt - ISO instant, or nothing.
 * @param {number|null|undefined} requested.maxViews - Positive integer, or nothing.
 * @param {ReturnType<typeof chatSharingSettings>} settings - Effective settings.
 * @param {number} [now] - Clock, for tests.
 * @returns {{ok: true, expiresAt: string|null, maxViews: number|null}|{ok: false, error: string}}
 */
export function resolveShareLimits({ expiresAt, maxViews }, settings, now = Date.now()) {
  let resolvedExpiry = null;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) return { ok: false, error: 'expiresAt must be an ISO-8601 date' };
    if (parsed <= now) return { ok: false, error: 'expiresAt must be in the future' };
    resolvedExpiry = new Date(parsed).toISOString();
  } else if (effectiveDefaultExpiryDays(settings) > 0) {
    resolvedExpiry = new Date(now + effectiveDefaultExpiryDays(settings) * DAY_MS).toISOString();
  }
  if (settings.maxExpiryDays > 0) {
    const latest = now + settings.maxExpiryDays * DAY_MS;
    if (!resolvedExpiry) {
      // The cap says every link must expire, and the owner asked for none:
      // the cap decides rather than the request being refused.
      resolvedExpiry = new Date(latest).toISOString();
    } else if (Date.parse(resolvedExpiry) > latest) {
      return {
        ok: false,
        error: `expiresAt may be at most ${settings.maxExpiryDays} day(s) from now`
      };
    }
  }

  let resolvedViews = null;
  if (maxViews !== undefined && maxViews !== null && maxViews !== '') {
    const parsed = Number(maxViews);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: 'maxViews must be a positive integer' };
    }
    resolvedViews = parsed;
  }
  if (settings.maxViewsCap > 0) {
    if (resolvedViews === null) resolvedViews = settings.maxViewsCap;
    else if (resolvedViews > settings.maxViewsCap) {
      return { ok: false, error: `maxViews may be at most ${settings.maxViewsCap}` };
    }
  }
  return { ok: true, expiresAt: resolvedExpiry, maxViews: resolvedViews };
}
