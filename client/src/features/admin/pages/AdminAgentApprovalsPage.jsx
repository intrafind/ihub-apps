import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchPendingInteractions } from '../../../api';
import AdminBreadcrumb from '../components/AdminBreadcrumb';

/** The actionable interaction kinds the queue shows, with their tab labels. */
const KINDS = [
  { id: 'all', label: ['admin.interactions.tabs.all', 'All'] },
  { id: 'approval', label: ['admin.interactions.tabs.approval', 'Approvals'] },
  { id: 'question', label: ['admin.interactions.tabs.question', 'Questions'] },
  { id: 'review', label: ['admin.interactions.tabs.review', 'Reviews'] }
];

const KIND_BADGE = {
  approval:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  question:
    'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800',
  review:
    'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300 border-sky-200 dark:border-sky-800'
};

/**
 * The interactions queue: every pending approval, question and review of a
 * paused agent run or workflow execution the caller may answer (admins see
 * all, approvers their groups', users their own runs'). Rows open the run
 * where the interaction is answered.
 */
export default function AdminAgentApprovalsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pending, setPending] = useState([]);
  const [kind, setKind] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const body = await fetchPendingInteractions();
        const items = Array.isArray(body?.interactions) ? body.interactions : [];
        setPending(items.filter(i => i && i.kind !== 'notify'));
      } catch (err) {
        setError(err?.response?.data?.error || err?.message || String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const counts = useMemo(() => {
    const out = { all: pending.length };
    for (const i of pending) out[i.kind] = (out[i.kind] || 0) + 1;
    return out;
  }, [pending]);
  const visible = kind === 'all' ? pending : pending.filter(i => i.kind === kind);

  const openRun = interaction => {
    const executionId = interaction.source?.executionId || interaction.runId;
    if (interaction.source?.profileId) {
      navigate(`/admin/agents/runs/${executionId}`);
    } else {
      navigate(`/workflows/executions/${executionId}`);
    }
  };

  const defaultMessage = interaction =>
    interaction.kind === 'question'
      ? t('admin.interactions.defaultQuestion', 'A question is waiting for an answer')
      : interaction.kind === 'review'
        ? t('admin.interactions.defaultReview', 'A review is requested')
        : t('admin.agents.approvals.defaultMessage', 'Approval requested');

  return (
    <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: t('admin.title', 'Admin'), href: '/admin' },
            { label: t('admin.agents.title', 'Agent Profiles'), href: '/admin/agents' },
            { label: t('admin.interactions.title', 'Pending Approvals & Questions') }
          ]}
        />
        <h1 className="text-2xl font-bold mb-2 text-gray-900 dark:text-gray-100">
          {t('admin.interactions.title', 'Pending Approvals & Questions')}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          {t(
            'admin.interactions.subtitle',
            'Every approval, question and review a paused agent run or workflow is waiting for.'
          )}
        </p>
        <div className="flex flex-wrap gap-2 mb-4" role="tablist">
          {KINDS.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={kind === tab.id}
              onClick={() => setKind(tab.id)}
              className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                kind === tab.id
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-indigo-400'
              }`}
            >
              {t(tab.label[0], tab.label[1])}
              <span className="ml-1 opacity-75">({counts[tab.id] || 0})</span>
            </button>
          ))}
        </div>
        {error && (
          <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
            {error}
          </div>
        )}
        {loading ? (
          <div className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading…')}</div>
        ) : visible.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-8 text-center text-gray-500 dark:text-gray-400">
            {t('admin.interactions.empty', 'Nothing is waiting for you.')}
          </div>
        ) : (
          <ul className="space-y-3">
            {visible.map(interaction => (
              <li
                key={interaction.id}
                className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-4"
              >
                <div className="flex justify-between items-start gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`shrink-0 px-2 py-0.5 text-xs rounded-full border ${
                          KIND_BADGE[interaction.kind] || KIND_BADGE.approval
                        }`}
                      >
                        {t(`admin.interactions.kind.${interaction.kind}`, interaction.kind)}
                      </span>
                      <p className="font-mono text-xs text-gray-600 dark:text-gray-400 truncate">
                        {interaction.source?.profileId || interaction.runId}
                        {interaction.source?.nodeName ? ` · ${interaction.source.nodeName}` : ''}
                      </p>
                    </div>
                    <p className="text-sm font-medium mt-1 text-gray-900 dark:text-gray-100">
                      {interaction.prompt?.message || defaultMessage(interaction)}
                    </p>
                    {interaction.createdAt && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {new Date(interaction.createdAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => openRun(interaction)}
                    className="shrink-0 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
                  >
                    {t('admin.agents.approvals.openRun', 'Open run')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
