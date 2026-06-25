/**
 * Canonical TaskRecord shape for the agent dynamic-task queue
 * (`state.data._taskQueue`).
 *
 * Consumers (`LoopNodeExecutor` drain mode, the run-detail UI) rely on
 * specific fields. Producers (`create_task` tool today, future plan
 * materializers tomorrow) must emit this shape — drift between producers
 * is what silently breaks drain.
 */

const VALID_STATUSES = new Set(['open', 'in_progress', 'done', 'failed', 'cancelled']);

/**
 * Validate that an object is a well-formed TaskRecord. Returns
 * `{ ok: true }` on success or `{ ok: false, reason }` on failure.
 *
 * Defensive — used by producers to refuse to push malformed entries.
 */
export function validateTaskRecord(t) {
  if (!t || typeof t !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof t.id !== 'string' || t.id.length === 0) return { ok: false, reason: 'id missing' };
  if (typeof t.title !== 'string' || t.title.length === 0)
    return { ok: false, reason: 'title missing' };
  if (typeof t.status !== 'string' || !VALID_STATUSES.has(t.status))
    return { ok: false, reason: `status must be one of ${[...VALID_STATUSES].join(', ')}` };
  if (typeof t.depth !== 'number' || t.depth < 0)
    return { ok: false, reason: 'depth must be a non-negative number' };
  return { ok: true };
}

/**
 * Derive a present-continuous "active form" label from an imperative title,
 * for spinner / live-plan display (TodoWrite convention: "Run tests" →
 * "Running tests"). Best-effort only — callers can pass an explicit
 * `activeForm` to override.
 */
export function deriveActiveForm(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const [first, ...rest] = t.split(/\s+/);
  const lower = first.toLowerCase();
  let gerund;
  if (/[^aeiou]e$/.test(lower)) {
    gerund = lower.replace(/e$/, 'ing'); // write → writing
  } else if (/[^aeiou][aeiou][^aeiouwxy]$/.test(lower) && lower.length <= 5) {
    gerund = `${lower}${lower.slice(-1)}ing`; // run → running
  } else {
    gerund = `${lower}ing`;
  }
  const verb = gerund.charAt(0).toUpperCase() + gerund.slice(1);
  return [verb, ...rest].join(' ');
}

/**
 * Build a TaskRecord from a partial input, filling in defaults and
 * timestamps. Throws if required fields can't be derived.
 *
 * `title` is the imperative form ("Run tests"); `activeForm` is the
 * present-continuous form shown while the task is in_progress. If omitted it
 * is derived from the title.
 */
export function buildTaskRecord({
  id,
  title,
  activeForm,
  description = '',
  brief = '',
  priority = 'p2',
  status = 'open',
  depth = 0,
  parentTaskId = null,
  createdBy = 'unknown'
}) {
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error('TaskRecord requires title');
  }
  const now = new Date().toISOString();
  const record = {
    id: id || `task_${now.replace(/[:.]/g, '-')}`,
    title,
    activeForm: activeForm && typeof activeForm === 'string' ? activeForm : deriveActiveForm(title),
    description,
    brief,
    priority,
    status,
    depth,
    parentTaskId,
    createdBy,
    result: null,
    createdAt: now,
    updatedAt: now
  };
  const v = validateTaskRecord(record);
  if (!v.ok) throw new Error(`invalid TaskRecord: ${v.reason}`);
  return record;
}

/**
 * Enforce the living-plan invariant: at most one task is `in_progress` at a
 * time (TodoWrite convention). When `keepId` is moved to in_progress, any
 * other in_progress task is demoted back to `open`. Mutates queue entries in
 * place and returns the list of demoted task ids (for event emission).
 */
export function enforceSingleInProgress(queue, keepId) {
  const demoted = [];
  if (!Array.isArray(queue)) return demoted;
  for (const t of queue) {
    if (t && t.status === 'in_progress' && t.id !== keepId) {
      t.status = 'open';
      t.updatedAt = new Date().toISOString();
      demoted.push(t.id);
    }
  }
  return demoted;
}

export const TASK_STATUSES = VALID_STATUSES;
