// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * Run routes (`/api/runs/*`, `/api/interactions/*`) — the unified runtime's
 * HTTP surface. Every human touchpoint (chat clarification, workflow `human`
 * node checkpoint, agent approval) is an interaction answered through the one
 * answer endpoint; steer / stop / feedback are human events on the run.
 *
 * Like every endpoint module, these resolve with the response body
 * (`handleApiResponse` unwraps the HTTP response).
 */

/**
 * Answer a pending interaction of a run.
 *
 * @param {string} runId - run the interaction belongs to (`interaction.runId`)
 * @param {string} interactionId
 * @param {Object} answer - `{ value?, data?, decision?, reason?, skipped? }`
 * @param {Object} [options]
 * @param {'chat'|'run_page'|'queue'|'api'} [options.channel='run_page'] - where the answer was given
 * @returns {Promise<Object>} the answered interaction
 */
export const answerInteraction = async (runId, interactionId, answer, options = {}) => {
  const { channel = 'run_page' } = options;
  return handleApiResponse(
    () =>
      apiClient.post(
        `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
        { ...answer, channel }
      ),
    null,
    null,
    false
  );
};

/**
 * Pending interactions of one run.
 * @param {string} runId
 * @returns {Promise<{ items: Object[] }>} the response body
 */
export const fetchRunInteractions = async runId => {
  return handleApiResponse(
    () => apiClient.get(`/runs/${encodeURIComponent(runId)}/interactions`),
    null,
    null,
    false
  );
};

/**
 * The interactions queue: every pending interaction the caller may see
 * (admins see all, approvers see their groups', owners see their own). An
 * admin sees more than an admin may answer: an interaction of a run a user
 * started that names no approver group is answered by that user only.
 * @param {Object} [options]
 * @param {string} [options.kind] - `question` | `approval` | `review` | `notify`
 * @returns {Promise<{ items: Object[] }>} the response body
 */
export const fetchPendingInteractions = async (options = {}) => {
  const { kind } = options;
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  return handleApiResponse(() => apiClient.get(`/interactions/pending${query}`), null, null, false);
};

/**
 * Deliver a human event into a run. `stop` aborts the run. A `steer` is a
 * message into the running answer: read at its next step, or with
 * `mode: 'afterwards'` sent as the next message once the answer is done.
 * @param {string} runId
 * @param {{ kind: 'steer'|'stop'|'feedback', message?: string, mode?: 'steer'|'afterwards', messageId?: string, rating?: number|string }} event
 * @returns {Promise<{ runId: string, seq: number|null, id?: string, effect?: string }>} the
 *   response body; a `steer` without `id` found no answer running to take it
 */
export const sendHumanEvent = async (runId, event) => {
  return handleApiResponse(
    () => apiClient.post(`/runs/${encodeURIComponent(runId)}/human-events`, event),
    null,
    null,
    false
  );
};

/**
 * Remove a message sent into the running answer (`sendHumanEvent`, `kind: 'steer'`)
 * before the answer reads it. Rejects with the problem's `status` and `code`:
 * 409 `STEER_ALREADY_APPLIED` once it was read or sent as the next message, 404
 * when it no longer waits, 503 when it cannot be decided right now.
 * @param {string} runId - The run it was sent to (`pending[].runId`)
 * @param {string} id - The id the POST answered with
 * @returns {Promise<void>}
 */
export const removeHumanEvent = async (runId, id) => {
  return handleApiResponse(
    () =>
      apiClient.delete(`/runs/${encodeURIComponent(runId)}/human-events/${encodeURIComponent(id)}`),
    null,
    null,
    false
  );
};

/**
 * Ledger events of a run (re-sync a live stream from a sequence number).
 * @param {string} runId
 * @param {Object} [options]
 * @param {string} [options.cursor] - The `nextCursor` of the previous page
 * @param {number} [options.limit]
 * @param {'sse'} [options.view] - `sse` returns SSE v2 envelopes
 * @returns {Promise<{ runId: string, items: Object[], nextCursor: string|null }>} the response body
 */
export const fetchRunEvents = async (runId, options = {}) => {
  const { cursor, limit, view } = options;
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  if (view) params.set('view', view);
  return handleApiResponse(
    () => apiClient.get(`/runs/${encodeURIComponent(runId)}/events?${params.toString()}`),
    null,
    null,
    false
  );
};
