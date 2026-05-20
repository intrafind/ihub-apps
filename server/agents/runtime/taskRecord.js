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
 * Build a TaskRecord from a partial input, filling in defaults and
 * timestamps. Throws if required fields can't be derived.
 */
export function buildTaskRecord({
  id,
  title,
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

export const TASK_STATUSES = VALID_STATUSES;
