// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The start of a chat turn, without an HTTP request.
 *
 * A turn is described by a {@link TurnRequest}: plain data that names the
 * chat, the app, who sends the message, and everything the sender chose for
 * this turn. The chat route (`routes/chat/sessionRoutes.js`) builds one from
 * its request; nothing in this module reads a request or writes a response.
 *
 * @module services/chat/chatTurnStart
 */
import { buildEnvelope } from '../loop/RunStream.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { toErrorResponse } from '../../utils/errorResponse.js';
import { guestIdOf, guestOwnerId } from './chatOwner.js';

/**
 * Who a turn is for, as plain data: no permissions, no groups, no secret.
 *
 * @typedef {Object} PrincipalRef
 * @property {'user'|'guest'} type - `guest` for an anonymous caller.
 * @property {string|null} id - The user id; for a guest the owner id its chats
 *   are stored under (`guest-<hash>`), or null when it has no guest identity.
 */

/**
 * What a caller's connection said about itself. A caller without a connection
 * leaves it out.
 *
 * @typedef {Object} TurnClient
 * @property {string} [sessionId] - The browser session (`X-Session-Id`), for the logs.
 * @property {string} [userAgent] - For the session log.
 * @property {string} [ip] - For the audit entry of a call resumed after a connect.
 * @property {string} [url] - The address that was asked, from which that audit
 *   entry derives its source.
 */

/**
 * One chat turn to start, as plain data. It lists every input of a turn: what
 * is not named here does not reach the turn.
 *
 * `modelId` and the settings from `style` to `integrationScopes` are what this
 * turn names; what it leaves out (`undefined`) is what the chat was last
 * answered with (`chatTurnSettings`).
 *
 * @typedef {Object} TurnRequest
 * @property {string} chatId
 * @property {string} appId
 * @property {PrincipalRef} principalRef - Who sends the message.
 * @property {string|null} messageId - The sender's id for the new message.
 * @property {Object} [message] - The new message: `content`, and what it
 *   carries with it: uploads (`fileData`, `imageData`, `audioData`, each one
 *   object or a list, and `fileIds` for files uploaded before), `variables`,
 *   `hostContext`, a `clarificationResponse`, an `approvalResponse`, a
 *   `connectResume`. Left out (`undefined`), the turn is refused.
 * @property {number} [clientHistory] - How many earlier messages the caller
 *   sent along with the new one. The server owns the history, so any refuses
 *   the turn (`CLIENT_HISTORY_NOT_ALLOWED`).
 * @property {string} [modelId]
 * @property {string} [style]
 * @property {string} [outputFormat]
 * @property {boolean} [sendChatHistory]
 * @property {boolean} [thinkingEnabled]
 * @property {string} [thinkingLevel]
 * @property {boolean} [thinkingThoughts]
 * @property {string[]} [enabledTools]
 * @property {boolean} [websearchEnabled]
 * @property {string} [imageAspectRatio]
 * @property {string} [imageQuality]
 * @property {Object<string, string>} [integrationScopes] - The scope picked per integration.
 * @property {string} [language] - The language the sender works in; the
 *   platform's default language when left out.
 * @property {string|null} [clientTimezone] - The sender's IANA time zone.
 * @property {boolean} [toolApprovalCapable] - The sender's client draws tool approval cards.
 * @property {'person'} origin - What started the turn. A message somebody sent is `person`.
 * @property {*} [bypassAppPrompts]
 * @property {string[]} [requestedSkills]
 * @property {string[]} [documentIds]
 * @property {string} [replaceFromMessageId] - The message an edit or a regenerate forks from.
 * @property {boolean} [ephemeral] - Start a temporary chat.
 * @property {Object} [mcpAppContext] - What open MCP App views reported since the last turn.
 * @property {boolean} [voiceMode]
 * @property {string|null} [projectId] - The chat's container project.
 * @property {string[]} [projects] - The projects attached for this turn.
 * @property {string} [testProjectId] - The admin project a project test puts in scope.
 * @property {TurnClient} [client]
 */

/**
 * The principal reference of a resolved user.
 *
 * @param {Object} [user] - A resolved user, as a request carries it (`req.user`).
 * @returns {PrincipalRef}
 */
export function principalRefOf(user) {
  if (isAnonymousUser(user)) {
    const guestId = guestIdOf(user);
    return { type: 'guest', id: guestId ? guestOwnerId(guestId) : null };
  }
  return { type: 'user', id: String(user.id) };
}

/**
 * The frames that answer a refusal or failure after a turn's own stream
 * committed, when no status line can carry it any more: `stream/error`, then
 * the turn's `run/ended { status: 'error' }`. The error is described exactly
 * as its problem+json body would be (`toErrorResponse`): the same code, and a
 * 5xx message only when it is safe to show.
 *
 * @param {string} chatId
 * @param {string} runId - The turn's run
 * @param {Error} error
 * @returns {Object[]} SSE v2 envelopes
 */
export function lateRefusalFrames(chatId, runId, error) {
  const { body } = toErrorResponse(error);
  const frame = (type, data) => buildEnvelope({ streamId: chatId, runId, type, data });
  const described = { code: body.code, message: body.detail };
  return [
    frame(SSE_V2_EVENTS.STREAM_ERROR, {
      ...described,
      retryable: false,
      details: { ...body.details, status: body.status }
    }),
    frame(SSE_V2_EVENTS.RUN_ENDED, { status: 'error', finishReason: 'error', error: described })
  ];
}

/**
 * Chat-shaped view of a persisted transcript: role, content, and any hydrated
 * `fileData` payloads.
 *
 * Everything else on a stored message — ids, usage, the error of a failed turn,
 * attachment descriptors — is bookkeeping for the history UI and has no place
 * in a model prompt. Contentless turns are dropped with it: an aborted or
 * failed turn is stored with an empty answer, and several providers reject a
 * blank message outright.
 *
 * @param {Array<Object>} stored - Messages as `ChatRepository` returns them.
 * @returns {Array<{role: string, content: string, fileData?: Array<Object>, activeSkills?: Array<Object>}>} An answer
 *   keeps the skills it activated (`activity.activeSkills`), so they stay active.
 */
export function historyForPrompt(stored) {
  return stored
    .filter(
      entry =>
        entry?.role &&
        ((typeof entry.content === 'string' && entry.content.trim()) || Boolean(entry.fileData))
    )
    .map(entry => {
      // The skills an answer activated stay active in the chat; the request
      // builder reads them from here and re-checks access every turn.
      // A stored answer carries them in `activity`; a history rebuilt from the file
      // store (`hydrateHistoryForPrompt`) already has them as `activeSkills`.
      const skills =
        entry.role === 'assistant' ? (entry.activity?.activeSkills ?? entry.activeSkills) : null;
      return {
        role: entry.role,
        content: typeof entry.content === 'string' ? entry.content : '',
        ...(entry.fileData ? { fileData: entry.fileData } : {}),
        ...(Array.isArray(skills) && skills.length > 0 ? { activeSkills: skills } : {})
      };
    });
}

/**
 * Who brought a skill into the turn, by the route `resolveSkillsForTurn`
 * found it by: picked in the composer or `/name` in the message is the user's
 * (`requested`, `message`), `skillSettings.autoActivate` is the app's, and one
 * an earlier turn activated is kept (`chat`). The model's own activation is
 * announced by the `activate_skill` tool, not here.
 */
const SKILL_ACTIVATOR_OF_ORIGIN = Object.freeze({
  requested: 'user',
  message: 'user',
  app: 'app',
  chat: 'chat'
});

/**
 * The skills a turn announces on its run (`skill.activation`): every skill in
 * force, each saying who brought it in: the user, the app, or an earlier
 * message of the chat. A skill is shown once, in the activity block, with its
 * reason, so a carried-over skill is announced too.
 *
 * @param {Array<{name: string, displayName: string, description?: string, origin: string}>} [skills]
 *   `activeSkills` of the prepared request
 * @returns {Array<{skillName: string, skillId: string, activatedBy: 'user'|'app'|'chat', description: string}>}
 */
export function announcedSkills(skills) {
  return (Array.isArray(skills) ? skills : []).map(skill => ({
    skillName: skill.displayName,
    skillId: skill.name,
    activatedBy: SKILL_ACTIVATOR_OF_ORIGIN[skill.origin] || 'user',
    description: skill.description || ''
  }));
}

/**
 * Upload descriptors carried by a chat message, for the materializer to
 * normalize. The base64 payloads stay in the request: what a stored message
 * keeps is the fact that a file was attached, not the file.
 *
 * Each of the three fields is a single object for one upload and an array for
 * several — the shape the chat client has always sent and `RequestBuilder`
 * already handles — so they are flattened here. Without that an array is
 * `typeof 'object'` and survives as one opaque descriptor, turning three named
 * PDFs into a single nameless `{ type: 'file' }`.
 *
 * @param {Object} message - The new user message from the request.
 * @returns {Array<Object>}
 */
export function messageAttachments(message) {
  return [message?.fileData, message?.imageData, message?.audioData]
    .flatMap(value => (Array.isArray(value) ? value : value ? [value] : []))
    .filter(entry => entry && typeof entry === 'object');
}
