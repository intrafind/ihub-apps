/**
 * Scheduled-task proposals — what the scheduling tools hand the chat instead
 * of saving anything.
 *
 * A model that can create a recurring task on its own can be talked into one
 * by content it fetched: a web page, an email, a ticket. So `schedule_task`
 * (and a change to what an existing task does, and a delete) only returns a
 * proposal; the chat renders it as a confirmation card, and only the user's
 * click on that card calls the task API.
 *
 * The proposal rides on the `tool/completed` frame and is stored with the
 * answer. Only the scheduling tools may produce one — the tool projection
 * checks the tool's own definition, so another tool's result cannot draw a
 * card.
 *
 * @module services/scheduler/tasks/proposals
 */

/** The script the scheduling tools live in. */
export const SCHEDULING_TOOL_SCRIPT = 'scheduledTaskTools.js';

/** Proposals kept per stored answer. */
const MAX_STORED_PROPOSALS = 10;
/** Bytes a proposal may take once serialized. */
const MAX_PROPOSAL_BYTES = 32 * 1024;

const ACTIONS = new Set(['create', 'update', 'delete']);

/**
 * Whether a tool definition is one of the scheduling tools.
 *
 * @param {Object} toolDef
 * @returns {boolean}
 */
export function isSchedulingToolDef(toolDef) {
  return toolDef?.script === SCHEDULING_TOOL_SCRIPT;
}

/**
 * The proposal a tool result carries, bounded, or null.
 *
 * @param {unknown} raw - Tool result.
 * @returns {Object|null}
 */
export function proposalOf(raw) {
  const proposal = raw && typeof raw === 'object' ? raw.scheduledTaskProposal : null;
  if (!proposal || typeof proposal !== 'object') return null;
  if (typeof proposal.proposalId !== 'string' || !ACTIONS.has(proposal.action)) return null;
  const out = {
    proposalId: proposal.proposalId.slice(0, 64),
    action: proposal.action,
    ...(typeof proposal.taskId === 'string' ? { taskId: proposal.taskId.slice(0, 100) } : {}),
    ...(proposal.draft && typeof proposal.draft === 'object' ? { draft: proposal.draft } : {}),
    ...(proposal.summary && typeof proposal.summary === 'object'
      ? { summary: proposal.summary }
      : {})
  };
  try {
    if (JSON.stringify(out).length > MAX_PROPOSAL_BYTES) return null;
  } catch {
    return null;
  }
  return out;
}

/**
 * The proposals of a turn as stored with the answer: well-formed, one per id,
 * bounded.
 *
 * @param {unknown} proposals
 * @returns {Object[]}
 */
export function boundStoredProposals(proposals) {
  if (!Array.isArray(proposals)) return [];
  const out = [];
  for (const entry of proposals) {
    const proposal = proposalOf({ scheduledTaskProposal: entry });
    if (!proposal || out.some(p => p.proposalId === proposal.proposalId)) continue;
    out.push(proposal);
    if (out.length >= MAX_STORED_PROPOSALS) break;
  }
  return out;
}
