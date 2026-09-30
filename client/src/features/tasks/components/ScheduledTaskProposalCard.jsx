import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  createScheduledTask,
  deleteScheduledTask,
  fetchScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  updateScheduledTask
} from '../../../api';
import { useScheduledTasksAvailable } from '../hooks/useScheduledTasks';
import { errorCode, errorMessage, formatDateTime, responseData } from '../utils/taskFormat';

const STATE_KEY = 'ihub.scheduledTasks.proposals';

/** What this browser already did with a proposal (saved / dismissed). */
function readState(proposalId) {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}')[proposalId] || null;
  } catch {
    return null;
  }
}

function writeState(proposalId, value) {
  try {
    const all = JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}');
    all[proposalId] = value;
    sessionStorage.setItem(STATE_KEY, JSON.stringify(all));
  } catch {
    // Not persisted: the server still refuses a second save of the same card.
  }
}

// One task listing per page load, shared by every card, to tell whether a
// create card was already saved (the task carries its proposal id).
let savedLookup = null;
function savedTaskFor(proposalId) {
  if (!savedLookup) {
    savedLookup = fetchScheduledTasks()
      .then(data => data?.items || [])
      .catch(() => []);
  }
  return savedLookup.then(items => items.find(task => task.proposalId === proposalId) || null);
}

/**
 * A confirmation card for a scheduled task a scheduling tool proposed.
 * Nothing is created, changed or deleted until the user clicks here.
 *
 * @param {Object} props
 * @param {Object} props.proposal - `{ proposalId, action, taskId?, draft?, summary? }`
 * @param {string} [props.chatId]
 * @param {boolean} [props.readOnly=false] - A shared chat shows the card without actions.
 */
export function ScheduledTaskProposalCard({ proposal, chatId, readOnly = false }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const available = useScheduledTasksAvailable();
  const [state, setState] = useState(() => readState(proposal.proposalId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const summary = proposal.summary || {};
  const { action } = proposal;

  useEffect(() => {
    if (state || action !== 'create' || !available) return undefined;
    let cancelled = false;
    savedTaskFor(proposal.proposalId).then(task => {
      if (!cancelled && task) setState({ status: 'saved', taskId: task.id });
    });
    return () => {
      cancelled = true;
    };
  }, [state, action, available, proposal.proposalId]);

  const settle = value => {
    setState(value);
    writeState(proposal.proposalId, value);
  };

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      if (action === 'create') {
        const task = await createScheduledTask({
          ...proposal.draft,
          proposalId: proposal.proposalId,
          ...(chatId ? { sourceChatId: chatId } : {})
        });
        // The shared listing predates this task; a card mounted later reads anew.
        savedLookup = null;
        settle({ status: 'saved', taskId: task.id });
      } else if (action === 'update') {
        const { status, ...changes } = proposal.draft || {};
        if (Object.keys(changes).length > 0) await updateScheduledTask(proposal.taskId, changes);
        if (status === 'paused') await pauseScheduledTask(proposal.taskId);
        if (status === 'active') await resumeScheduledTask(proposal.taskId);
        settle({ status: 'saved', taskId: proposal.taskId });
      } else if (action === 'delete') {
        await deleteScheduledTask(proposal.taskId);
        settle({ status: 'deleted' });
      }
    } catch (err) {
      if (errorCode(err) === 'PROPOSAL_ALREADY_SAVED') {
        settle({ status: 'saved', taskId: responseData(err)?.details?.taskId || null });
      } else {
        setError(errorMessage(err, t('scheduledTasks.errors.save', 'The task could not be saved')));
      }
    } finally {
      setBusy(false);
    }
  }

  function editInForm() {
    if (action === 'create') {
      navigate('/tasks/new', {
        state: {
          draft: proposal.draft,
          proposalId: proposal.proposalId,
          ...(chatId ? { sourceChatId: chatId } : {})
        }
      });
    } else if (proposal.taskId) {
      navigate(`/tasks/${proposal.taskId}/edit`);
    }
  }

  const titles = {
    create: t('scheduledTasks.proposal.createTitle', 'Schedule this task?'),
    update: t('scheduledTasks.proposal.updateTitle', 'Change this task?'),
    delete: t('scheduledTasks.proposal.deleteTitle', 'Delete this task?')
  };
  const confirmLabels = {
    create: t('common.save', 'Save'),
    update: t('scheduledTasks.proposal.apply', 'Apply changes'),
    delete: t('common.delete', 'Delete')
  };

  return (
    <div className="mt-3 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/20 p-4 text-sm space-y-3">
      <div className="flex items-center gap-2">
        <Icon name="calendar" size="md" className="text-indigo-600 dark:text-indigo-400" />
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">{titles[action]}</h3>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
        {summary.name && (
          <>
            <dt className="text-gray-500">{t('scheduledTasks.fields.name', 'Name')}</dt>
            <dd className="text-gray-900 dark:text-gray-100 font-medium">{summary.name}</dd>
          </>
        )}
        {summary.appName && (
          <>
            <dt className="text-gray-500">{t('scheduledTasks.fields.app', 'App')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">{summary.appName}</dd>
          </>
        )}
        {summary.scheduleDescription && (
          <>
            <dt className="text-gray-500">{t('scheduledTasks.fields.schedule', 'Schedule')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">{summary.scheduleDescription}</dd>
          </>
        )}
        {Array.isArray(summary.nextRuns) && summary.nextRuns.length > 0 && action !== 'delete' && (
          <>
            <dt className="text-gray-500">{t('scheduledTasks.schedule.nextRuns', 'Next runs')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">
              {summary.nextRuns
                .slice(0, 3)
                .map(run =>
                  formatDateTime(run, i18n.language, { timeZone: summary.timezone, weekday: true })
                )
                .join(' · ')}
            </dd>
          </>
        )}
        {Array.isArray(summary.tools) && (
          <>
            <dt className="text-gray-500">
              {t('scheduledTasks.fields.tools', 'Tools and integrations')}
            </dt>
            <dd className="text-gray-900 dark:text-gray-100">
              {summary.tools.join(', ') || t('scheduledTasks.noTools', 'None')}
            </dd>
          </>
        )}
        {summary.instructions && (
          <>
            <dt className="text-gray-500">
              {t('scheduledTasks.fields.instructions', 'Instructions')}
            </dt>
            <dd className="text-gray-900 dark:text-gray-100 whitespace-pre-wrap">
              {summary.instructions}
            </dd>
          </>
        )}
        {summary.before?.scheduleDescription &&
          summary.before.scheduleDescription !== summary.scheduleDescription && (
            <>
              <dt className="text-gray-500">{t('scheduledTasks.proposal.before', 'Before')}</dt>
              <dd className="text-gray-500 line-through">{summary.before.scheduleDescription}</dd>
            </>
          )}
      </dl>

      {state?.status === 'saved' && (
        <p className="text-green-700 dark:text-green-400">
          {action === 'update'
            ? t('scheduledTasks.proposal.applied', 'Changes applied.')
            : t('scheduledTasks.proposal.saved', 'Saved.')}{' '}
          {state.taskId && (
            <Link
              to={`/tasks/${state.taskId}`}
              className="text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {t('scheduledTasks.openTask', 'Open task')}
            </Link>
          )}
        </p>
      )}
      {state?.status === 'deleted' && (
        <p className="text-green-700 dark:text-green-400">
          {t('scheduledTasks.proposal.deleted', 'Deleted.')}
        </p>
      )}
      {state?.status === 'dismissed' && (
        <p className="text-gray-500">{t('scheduledTasks.proposal.dismissed', 'Not saved.')}</p>
      )}

      {!state && !readOnly && available && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-60 ${
              action === 'delete'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {confirmLabels[action]}
          </button>
          {action !== 'delete' && (
            <button
              type="button"
              disabled={busy}
              onClick={editInForm}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-white dark:hover:bg-gray-800"
            >
              {t('scheduledTasks.proposal.edit', 'Edit in form')}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => settle({ status: 'dismissed' })}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800"
          >
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      )}
      {!available && !state && (
        <p className="text-xs text-gray-500">
          {t('scheduledTasks.proposal.unavailable', 'Scheduled tasks are not available right now.')}
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** Every proposal of an answer. */
export default function ScheduledTaskProposalCards({ proposals, chatId, readOnly }) {
  if (!Array.isArray(proposals) || proposals.length === 0) return null;
  return proposals.map(proposal => (
    <ScheduledTaskProposalCard
      key={proposal.proposalId}
      proposal={proposal}
      chatId={chatId}
      readOnly={readOnly}
    />
  ));
}
