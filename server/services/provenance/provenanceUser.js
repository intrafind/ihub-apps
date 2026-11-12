// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who a stored provenance record names (`provenance.recordUser`).
 *
 * The modes are the ones usage tracking and feedback already use, with the
 * same meaning, plus `none`:
 *
 * - `none` (default): the record names nobody.
 * - `anonymous`: a one-way fingerprint of the user (`usr_<16 hex>`, salted with
 *   the installation's pepper). The same user is always the same value, so
 *   records of one person can be grouped, and someone who knows a user id and
 *   the pepper can check whether a record is theirs; nobody can read the id
 *   back from it.
 * - `pseudonymous`: the conversation stands in for the user, as a fingerprint
 *   of the chat, run or execution id (`conv_<16 hex>`), so records of one
 *   conversation can be grouped and an id that embeds a user id
 *   (`inference:<userId>`) is never written; a call outside a conversation
 *   falls back to the user fingerprint.
 * - `identified`: the user id (never the name or email).
 *
 * The value lives only in the stored record. It is never part of the
 * provenance object a client or API caller receives, and the verify endpoint
 * shows it to admins only.
 *
 * @module services/provenance/provenanceUser
 */
import logger from '../../utils/logger.js';
import { fingerprintConversation } from '../UserFingerprint.js';
import { resolveIdentity } from '../usage/usageRecorder.js';
import { provenanceSettings } from './provenanceSettings.js';

/**
 * The `user` member of a stored record, or null when nothing is recorded.
 *
 * @param {Object} input
 * @param {Object|null} [input.user] - The acting user (`req.user`-like)
 * @param {string|null} [input.conversationId] - Chat, run or execution id
 * @param {string} [mode] - Default: the platform setting
 * @returns {Promise<{mode: string, id: string}|null>}
 */
export async function recordedUser(
  { user, conversationId } = {},
  mode = provenanceSettings().recordUser
) {
  if (!mode || mode === 'none' || !user) return null;
  try {
    if (mode === 'pseudonymous' && conversationId) {
      const id = await fingerprintConversation(String(conversationId));
      if (id) return { mode, id };
    }
    const { uid } = await resolveIdentity({
      user,
      conversationId: null,
      // Without a conversation, pseudonymous falls back to the user fingerprint.
      mode: mode === 'pseudonymous' ? 'anonymous' : mode
    });
    return uid ? { mode, id: String(uid) } : null;
  } catch (error) {
    // Naming the user is never worth losing the record.
    logger.warn('Could not resolve the user of a provenance record', {
      component: 'ProvenanceUser',
      error: error.message
    });
    return null;
  }
}

/**
 * A record as a verify caller may see it: the `user` member only for admins.
 *
 * @param {Object} record
 * @param {boolean} isAdmin
 * @returns {Object}
 */
export function recordForCaller(record, isAdmin) {
  if (isAdmin || !record || record.user === undefined) return record;
  const { user: _user, ...rest } = record;
  return rest;
}
