/**
 * What the model needs to know to schedule work for a person: what time it
 * is for them, and in which timezone.
 *
 * The scheduling tools take absolute times. The model resolves "in two
 * hours", "tomorrow morning" or "every other Tuesday at three" itself, so the
 * turn's system prompt carries the user's current local time whenever one of
 * those tools is offered; the confirmation card then shows the absolute
 * result for the user to check.
 *
 * @module services/scheduler/tasks/schedulingContext
 */
import { formatZonedIso, isValidTimezone } from '../schedule.js';

/** Tools whose use needs the scheduling note. */
const TOOLS_NEEDING_TIME = new Set(['schedule_task', 'update_scheduled_task']);

const NOTE_MARKER = 'Scheduling context:';

/**
 * Append the scheduling note to the system message when a scheduling tool is
 * offered. No-op otherwise, and when the note is already there.
 *
 * @param {Array<Object>} llmMessages - Prepared messages (mutated).
 * @param {Array<Object>} tools - Tools offered this turn.
 * @param {Object} [options]
 * @param {string|null} [options.timezone] - The user's IANA timezone.
 * @param {number} [options.now=Date.now()]
 * @returns {boolean} Whether the note was added.
 */
export function appendSchedulingContextNote(
  llmMessages,
  tools,
  { timezone, now = Date.now() } = {}
) {
  if (!Array.isArray(tools) || !tools.some(tool => TOOLS_NEEDING_TIME.has(tool?.id))) return false;
  if (!Array.isArray(llmMessages)) return false;
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  const note =
    `${NOTE_MARKER} the user's current local time is ${formatZonedIso(now, zone)} ` +
    `(timezone ${zone}). Use this timezone for scheduled tasks unless the user names another ` +
    'one, and turn relative times ("in 2 hours", "tomorrow morning") into absolute ones. ' +
    'Creating, changing or deleting a scheduled task only proposes it: the user confirms it on ' +
    'a card in the chat, so tell them to review and save it there.';
  const system = llmMessages.find(message => message.role === 'system');
  if (system && typeof system.content === 'string') {
    if (system.content.includes(NOTE_MARKER)) return false;
    system.content = system.content ? `${system.content}\n\n${note}` : note;
    return true;
  }
  llmMessages.unshift({ role: 'system', content: note });
  return true;
}

export default appendSchedulingContextNote;
