import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';

/**
 * Run routes (`/api/runs/*`, `/api/interactions/*`) — the unified runtime's
 * HTTP surface. Every human touchpoint (chat clarification, workflow `human`
 * node checkpoint, agent approval) is an interaction answered through the one
 * answer endpoint; steer / stop / feedback are human events on the run.
 */

/**
 * Answer a pending interaction of a run.
 *
 * @param {string} runId - run the interaction belongs to (`interaction.runId`)
 * @param {string} interactionId
 * @param {Object} answer - `{ value?, data?, decision?, reason?, skipped? }`
 * @param {Object} [options]
 * @param {'chat'|'run_page'|'queue'|'api'} [options.channel='run_page'] - where the answer was given
 * @returns {Promise<{ data: { success: boolean, interaction: Object } }>}
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
 * @returns {Promise<{ data: { runId: string, interactions: Object[] } }>}
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
 * The interactions queue: every pending interaction the caller may answer
 * (admins see all, approvers see their groups', owners see their own).
 * @param {Object} [options]
 * @param {string} [options.kind] - `question` | `approval` | `review` | `notify`
 * @returns {Promise<{ data: { interactions: Object[] } }>}
 */
export const fetchPendingInteractions = async (options = {}) => {
  const { kind } = options;
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  return handleApiResponse(() => apiClient.get(`/interactions/pending${query}`), null, null, false);
};

/**
 * Deliver a human event into a run. `stop` aborts the run.
 * @param {string} runId
 * @param {{ kind: 'steer'|'stop'|'feedback', message?: string, messageId?: string, rating?: number|string }} event
 * @returns {Promise<{ data: { success: boolean, runId: string, seq: number|null, effect?: string } }>}
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
 * Ledger events of a run (re-sync a live stream from a sequence number).
 * @param {string} runId
 * @param {Object} [options]
 * @param {number} [options.after=0]
 * @param {'sse'} [options.view] - `sse` returns SSE v2 envelopes
 * @returns {Promise<{ data: { runId: string, after: number, events: Object[], lastSeq: number } }>}
 */
export const fetchRunEvents = async (runId, options = {}) => {
  const { after = 0, view } = options;
  const params = new URLSearchParams({ after: String(after) });
  if (view) params.set('view', view);
  return handleApiResponse(
    () => apiClient.get(`/runs/${encodeURIComponent(runId)}/events?${params.toString()}`),
    null,
    null,
    false
  );
};
