import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { answerScheduledTaskApproval } from '../../../api';
import { errorMessage, formatDateTime } from '../utils/taskFormat';

/**
 * Approve or reject the tool call a scheduled run is waiting for, optionally
 * for every future run of the task ("Always allow for this task").
 *
 * @param {Object} props
 * @param {string} props.taskId
 * @param {Object} props.run - Run with `status: 'awaiting_approval'` and `approval`.
 * @param {() => void} [props.onAnswered]
 * @param {boolean} [props.compact=false]
 */
export default function ApprovalControls({ taskId, run, onAnswered, compact = false }) {
  const { t, i18n } = useTranslation();
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const approval = run?.approval || {};

  async function answer(decision) {
    setBusy(true);
    setError(null);
    try {
      await answerScheduledTaskApproval(taskId, run.id, {
        decision,
        alwaysAllow: decision === 'approve' && alwaysAllow
      });
      onAnswered?.(decision);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const args = approval.args && Object.keys(approval.args).length > 0 ? approval.args : null;

  return (
    <div
      className={`rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 ${
        compact ? 'p-2' : 'p-3'
      } text-sm space-y-2`}
    >
      <p className="text-amber-900 dark:text-amber-200">
        {t('scheduledTasks.approval.question', 'Allow this run to use {{tool}}?', {
          tool: approval.toolId || t('scheduledTasks.approval.aTool', 'a tool')
        })}
      </p>
      {args && (
        <pre className="max-h-40 overflow-auto rounded bg-white/70 dark:bg-gray-900/40 p-2 text-xs text-gray-800 dark:text-gray-200">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
      {approval.expiresAt && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {t('scheduledTasks.approval.expires', 'Expires {{time}}', {
            time: formatDateTime(approval.expiresAt, i18n.language)
          })}
        </p>
      )}
      <label className="inline-flex items-center gap-2 text-amber-900 dark:text-amber-200">
        <input
          type="checkbox"
          checked={alwaysAllow}
          onChange={e => setAlwaysAllow(e.target.checked)}
          className="rounded border-amber-400 text-indigo-600"
        />
        {t('scheduledTasks.approval.alwaysAllow', 'Always allow for this task')}
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => answer('approve')}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {t('scheduledTasks.approval.approve', 'Approve')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => answer('reject')}
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-white dark:hover:bg-gray-800 disabled:opacity-60"
        >
          {t('scheduledTasks.approval.reject', 'Reject')}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
