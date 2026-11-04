// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Writes usage records: one `llm_call` per model call (called by `LLMClient`
 * for every surface) and one `feedback` per rating. Applies the tracking
 * switch and mode — who `uid` and `cid` name — and never throws.
 *
 * Tracking modes:
 * - `identified`: `uid` is the user id, `cid` the conversation / run id.
 * - `anonymous`: `uid` and `cid` are one-way fingerprints of the same.
 * - `pseudonymous` (default): `uid` is the session — the conversation or run
 *   id — so one person appears as one user per conversation.
 * A call without a user (system work) has no `uid`.
 *
 * @module services/usage/usageRecorder
 */
import configCache from '../../configCache.js';
import { isFeatureEnabled } from '../../featureRegistry.js';
import logger from '../../utils/logger.js';
import { recordTokenUsage } from '../../telemetry.js';
import { recordFeedbackEvent as recordFeedbackMetric } from '../../telemetry/metrics.js';
import { fingerprint, fingerprintConversation } from '../UserFingerprint.js';
import { appendUsageRecord } from '../UsageEventLog.js';
import { quotaUserKey } from '../quota/quotaService.js';
import { buildCallRecord, buildFeedbackRecord, reportGroupsOf } from './callRecord.js';

const TRACKING_MODES = ['anonymous', 'pseudonymous', 'identified'];

/** The one-way fingerprint functions identities are resolved with. */
const FINGERPRINTS = Object.freeze({ fingerprint, fingerprintConversation });

/** Whether usage tracking is on (`features.usageTracking`). */
export function isUsageTrackingEnabled() {
  try {
    return isFeatureEnabled('usageTracking', configCache.getFeatures?.() || {}) !== false;
  } catch {
    return true;
  }
}

/** The tracking mode in force (`features.usageTrackingMode`). */
export function getUsageTrackingMode() {
  const mode = configCache.getPlatform?.()?.features?.usageTrackingMode;
  return TRACKING_MODES.includes(mode) ? mode : 'pseudonymous';
}

/**
 * Resolve `uid` and `cid` for the tracking mode.
 *
 * @param {Object} params
 * @param {Object|null} params.user
 * @param {string|null} params.conversationId
 * @param {string} params.mode
 * @param {Object} [deps] - fingerprint functions (tests)
 * @returns {Promise<{uid: string|null, cid: string|null}>}
 */
export async function resolveIdentity({ user, conversationId, mode }, deps = FINGERPRINTS) {
  const key = user ? quotaUserKey(user) : null;
  const conv = conversationId ? String(conversationId) : null;
  if (mode === 'identified') return { uid: key, cid: conv };
  if (mode === 'anonymous') {
    return {
      uid: key ? await deps.fingerprint(key) : null,
      cid: conv ? await deps.fingerprintConversation(conv) : null
    };
  }
  // pseudonymous: the session (conversation) stands in for the user.
  return { uid: key ? conv || (await deps.fingerprint(key)) : null, cid: conv };
}

/**
 * Record one finished model call. Never throws.
 *
 * @param {Object} call - see `buildCallRecord`, with `user` instead of `uid`
 *   and `groups`
 * @returns {Promise<Object|null>} the record written, or null
 */
export async function recordLlmCall(call) {
  try {
    if (!isUsageTrackingEnabled()) return null;
    const mode = getUsageTrackingMode();
    const { uid, cid } = await resolveIdentity({
      user: call.user || null,
      conversationId: call.conversationId || null,
      mode
    });
    const record = buildCallRecord({
      ...call,
      uid,
      conversationId: cid,
      groups: reportGroupsOf(call.user)
    });
    appendUsageRecord(record);
    recordTokenUsage((record.pt || 0) + (record.ct || 0));
    return record;
  } catch (error) {
    logger.warn('Could not record model call usage', { component: 'UsageRecorder', error });
    return null;
  }
}

/**
 * Record one feedback rating. Never throws.
 *
 * @param {{user: Object|null, appId?: string, modelId?: string,
 *   conversationId?: string, rating: number|string}} fb
 * @returns {Promise<Object|null>}
 */
export async function recordFeedback(fb) {
  try {
    recordFeedbackMetric(fb.appId, fb.rating);
    if (!isUsageTrackingEnabled()) return null;
    // Feedback storage off (`features.feedbackTracking: false`) keeps nothing,
    // the usage statistics included.
    if (configCache.getPlatform?.()?.features?.feedbackTracking === false) return null;
    const mode = getUsageTrackingMode();
    const { uid, cid } = await resolveIdentity({
      user: fb.user || null,
      conversationId: fb.conversationId || null,
      mode
    });
    const record = buildFeedbackRecord({
      ...fb,
      uid,
      conversationId: cid,
      groups: reportGroupsOf(fb.user)
    });
    appendUsageRecord(record);
    return record;
  } catch (error) {
    logger.warn('Could not record feedback usage', { component: 'UsageRecorder', error });
    return null;
  }
}
