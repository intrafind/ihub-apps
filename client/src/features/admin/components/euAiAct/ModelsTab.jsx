import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  acknowledgeUnmarkedModel,
  withdrawModelAcknowledgement
} from '../../../../api/aiTransparencyAdminApi';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { DataTable, FilterSelect } from '../data-table';
import { canAcknowledgeModel, filterModels, modelNeedsAttention } from '../../utils/euAiAct';
import { CompliancePill, ConformancePill } from './ComplianceBadges';
import JustificationDialog from './JustificationDialog';
import RecordSummary from './RecordSummary';

const ACTION_BUTTON =
  'inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
const ACTION_LINK =
  'text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500 rounded-sm whitespace-nowrap';

/**
 * Text-marking cell: how (and whether) the model's free-form text is marked.
 *
 * @param {Object} props
 * @param {Object} props.text - `model.text` from the status.
 */
function TextMarkingCell({ text }) {
  const { t } = useTranslation();
  if (!text) return <span aria-hidden="true">—</span>;
  switch (text.status) {
    case 'marked-vllm':
      return (
        <div className="space-y-1">
          <CompliancePill tone="success">
            {t('admin.euAiAct.models.text.markedVllm', 'Marked (vLLM watermark)')}
          </CompliancePill>
          <div className="text-xs text-gray-600 dark:text-gray-400">
            {t('admin.euAiAct.models.text.keyGroup', 'Key group: {{keyGroup}}', {
              keyGroup: text.keyGroup
            })}
            {text.perRequest &&
              ` · ${t('admin.euAiAct.models.text.perRequest', 'key sent per request')}`}
          </div>
          {text.keyGroupMissing && (
            <CompliancePill tone="error">
              {t('admin.euAiAct.models.text.keyGroupMissing', 'Key group missing')}
            </CompliancePill>
          )}
        </div>
      );
    case 'marked-upstream':
      return (
        <div className="space-y-1">
          <CompliancePill tone="success">
            {t('admin.euAiAct.models.text.markedUpstream', 'Marked by the vendor')}
          </CompliancePill>
          {text.vendor && (
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {t('admin.euAiAct.models.text.vendor', 'Technique: {{vendor}}', {
                vendor: text.vendor
              })}
            </div>
          )}
        </div>
      );
    case 'not-applicable':
      return (
        <CompliancePill tone="neutral">
          {t('admin.euAiAct.models.text.notApplicable', 'Not applicable')}
        </CompliancePill>
      );
    default:
      return (
        <CompliancePill tone="error">
          {t('admin.euAiAct.models.text.notMarked', 'Not marked')}
        </CompliancePill>
      );
  }
}

/**
 * Image-marking cell for image-generating models; a dash for the others.
 *
 * @param {Object} props
 * @param {Object|null} props.image - `model.image` from the status.
 */
function ImageMarkingCell({ image }) {
  const { t } = useTranslation();
  if (!image) {
    return (
      <span className="text-gray-400 dark:text-gray-500">
        <span aria-hidden="true">—</span>
        <span className="sr-only">
          {t('admin.euAiAct.models.image.notImageModel', 'Not an image model')}
        </span>
      </span>
    );
  }
  const yes = t('admin.euAiAct.common.yes', 'yes');
  const no = t('admin.euAiAct.common.no', 'no');
  let pill;
  if (image.status === 'marked') {
    pill = (
      <CompliancePill tone="success">
        {t('admin.euAiAct.models.image.marked', 'Marked (C2PA + watermark)')}
      </CompliancePill>
    );
  } else if (image.status === 'partial') {
    pill = (
      <CompliancePill tone="warning">
        {t('admin.euAiAct.models.image.partial', 'Partially marked')}
      </CompliancePill>
    );
  } else {
    pill = (
      <CompliancePill tone="error">
        {t('admin.euAiAct.models.image.notMarked', 'Not marked')}
      </CompliancePill>
    );
  }
  return (
    <div className="space-y-1">
      {pill}
      <div className="text-xs text-gray-600 dark:text-gray-400">
        {t('admin.euAiAct.models.image.layers', 'C2PA: {{c2pa}} · Watermark: {{watermark}}', {
          c2pa: image.c2pa ? yes : no,
          watermark: image.watermark ? yes : no
        })}
        {image.upstream &&
          ` · ${t('admin.euAiAct.models.image.upstream', 'Vendor: {{technique}}', {
            technique: image.upstream
          })}`}
      </div>
    </div>
  );
}

/**
 * Models tab of the EU AI Act page: the model compliance matrix.
 *
 * Per model it shows whether free-form text is marked (vLLM watermark / by
 * the vendor / not marked), whether generated images are marked, the
 * acknowledgement of a known gap, and the conformance. An acknowledged
 * unmarked model stays "Non-conforming": the acknowledgement documents the
 * gap, it does not close it (CoP Sub-measure 1.1.2).
 *
 * @param {Object} props
 * @param {Object} props.status - `GET /admin/ai-transparency/status` response.
 * @param {() => Promise<unknown>} props.reload - Re-fetches the status.
 */
function ModelsTab({ status, reload }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [filter, setFilter] = useState('all');
  const [ackTarget, setAckTarget] = useState(null);
  const [withdrawingId, setWithdrawingId] = useState(null);
  const [message, setMessage] = useState(null);

  const models = Array.isArray(status?.models) ? status.models : [];
  const rows = filterModels(models, filter);
  const nameOf = model => getLocalizedContent(model.name, language) || model.id;

  const handleAcknowledge = async justification => {
    await acknowledgeUnmarkedModel(ackTarget.id, justification);
    setMessage({
      type: 'success',
      text: t(
        'admin.euAiAct.models.acknowledged',
        'Acknowledgement recorded for {{name}}. The model stays non-conforming.',
        { name: nameOf(ackTarget) }
      )
    });
    await reload();
  };

  const handleWithdraw = async model => {
    setWithdrawingId(model.id);
    setMessage(null);
    try {
      await withdrawModelAcknowledgement(model.id);
      setMessage({
        type: 'success',
        text: t('admin.euAiAct.models.withdrawn', 'Acknowledgement for {{name}} withdrawn.', {
          name: nameOf(model)
        })
      });
      await reload();
    } catch (err) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(err) });
    } finally {
      setWithdrawingId(null);
    }
  };

  const columns = [
    {
      key: 'name',
      header: t('admin.euAiAct.models.columns.model', 'Model'),
      sortable: true,
      sortAccessor: m => nameOf(m),
      valign: 'top',
      render: m => (
        <div className="min-w-0">
          <div className="font-medium text-gray-900 dark:text-gray-100 break-words">
            {nameOf(m)}
          </div>
          <div className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{m.id}</div>
        </div>
      )
    },
    {
      key: 'provider',
      header: t('admin.euAiAct.models.columns.provider', 'Provider'),
      sortable: true,
      hideBelow: 'lg',
      valign: 'top',
      render: m => m.provider || '—'
    },
    {
      key: 'enabled',
      header: t('admin.euAiAct.models.columns.enabled', 'Enabled'),
      sortable: true,
      sortAccessor: m => (m.enabled ? 1 : 0),
      valign: 'top',
      render: m =>
        m.enabled ? (
          <CompliancePill tone="info">
            {t('admin.euAiAct.common.enabled', 'Enabled')}
          </CompliancePill>
        ) : (
          <CompliancePill tone="neutral">
            {t('admin.euAiAct.common.disabled', 'Disabled')}
          </CompliancePill>
        )
    },
    {
      key: 'text',
      header: t('admin.euAiAct.models.columns.text', 'Text marking'),
      sortable: true,
      sortAccessor: m => m.text?.status || '',
      valign: 'top',
      render: m => <TextMarkingCell text={m.text} />
    },
    {
      key: 'image',
      header: t('admin.euAiAct.models.columns.image', 'Image marking'),
      hideBelow: 'md',
      valign: 'top',
      render: m => <ImageMarkingCell image={m.image} />
    },
    {
      key: 'acknowledgement',
      header: t('admin.euAiAct.models.columns.acknowledgement', 'Acknowledgement'),
      hideBelow: 'md',
      valign: 'top',
      maxWidth: 'md',
      render: m =>
        m.acknowledgement ? (
          <RecordSummary record={m.acknowledgement} compact />
        ) : (
          <span className="text-gray-400 dark:text-gray-500">
            <span aria-hidden="true">—</span>
            <span className="sr-only">
              {t('admin.euAiAct.models.noAcknowledgement', 'No acknowledgement')}
            </span>
          </span>
        )
    },
    {
      key: 'conforming',
      header: t('admin.euAiAct.models.columns.conformance', 'Conformance'),
      sortable: true,
      sortAccessor: m => (m.conforming ? 1 : 0),
      valign: 'top',
      render: m => (
        <div className="space-y-1">
          <ConformancePill conforming={m.conforming} />
          {!m.conforming && m.acknowledgement && (
            <div className="text-xs text-gray-600 dark:text-gray-400 whitespace-normal">
              {t(
                'admin.euAiAct.models.acknowledgedGap',
                'Known gap acknowledged — still non-conforming.'
              )}
            </div>
          )}
        </div>
      )
    },
    {
      key: 'actions',
      header: t('admin.euAiAct.models.columns.actions', 'Actions'),
      valign: 'top',
      maxWidth: 'sm',
      render: m => {
        const name = nameOf(m);
        return (
          <div className="flex flex-col items-start gap-1.5">
            {canAcknowledgeModel(m) && (
              <button
                type="button"
                className={ACTION_BUTTON}
                onClick={() => {
                  setMessage(null);
                  setAckTarget(m);
                }}
              >
                {t('admin.euAiAct.models.acknowledge', 'Acknowledge…')}
                <span className="sr-only">: {name}</span>
              </button>
            )}
            {m.acknowledgement && (
              <button
                type="button"
                className={ACTION_BUTTON}
                onClick={() => handleWithdraw(m)}
                disabled={withdrawingId === m.id}
              >
                {withdrawingId === m.id
                  ? t('admin.euAiAct.models.withdrawing', 'Withdrawing…')
                  : t('admin.euAiAct.models.withdraw', 'Withdraw acknowledgement')}
                <span className="sr-only">: {name}</span>
              </button>
            )}
            <Link to={`/admin/models/${encodeURIComponent(m.id)}`} className={ACTION_LINK}>
              {t('admin.euAiAct.models.edit', 'Edit model')}
              <span className="sr-only">: {name}</span>
            </Link>
          </div>
        );
      }
    }
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.euAiAct.models.title', 'Model compliance matrix')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.euAiAct.models.description',
            'Whether each model marks its output: text by a vLLM watermark or by the upstream vendor, images by a signed C2PA manifest and an invisible watermark. Enabling an unmarked model needs an acknowledgement with a justification. The acknowledgement documents the gap; the model stays non-conforming.'
          )}
        </p>
      </div>

      <div aria-live="polite" role="status">
        {message && (
          <p
            className={`rounded-md border px-4 py-3 text-sm ${
              message.type === 'success'
                ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300'
            }`}
          >
            {message.text}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label={t('admin.euAiAct.models.filter.label', 'Show')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('admin.euAiAct.models.filter.all', 'All models') },
            {
              value: 'attention',
              label: t('admin.euAiAct.models.filter.attention', 'Enabled and non-conforming')
            },
            {
              value: 'nonConforming',
              label: t('admin.euAiAct.models.filter.nonConforming', 'Non-conforming')
            },
            { value: 'enabled', label: t('admin.euAiAct.models.filter.enabled', 'Enabled') }
          ]}
        />
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {t('admin.euAiAct.models.count', 'Models shown: {{shown}} of {{total}}', {
            shown: rows.length,
            total: models.length
          })}
        </span>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={m => m.id}
        stickyHeader={false}
        rowClassName={m => (modelNeedsAttention(m) ? 'bg-red-50/40 dark:bg-red-900/10' : '')}
        empty={{
          icon: 'cpu-chip',
          title: t('admin.euAiAct.models.empty', 'No models match this filter.')
        }}
      />

      <JustificationDialog
        open={Boolean(ackTarget)}
        title={t(
          'admin.euAiAct.models.ackDialog.title',
          'Acknowledge unmarked output of {{name}}',
          {
            name: ackTarget ? nameOf(ackTarget) : ''
          }
        )}
        description={
          <>
            <p>
              {t(
                'admin.euAiAct.models.ackDialog.description',
                'This model does not mark all of its output. Recording an acknowledgement documents the known gap and why you accept it, for example that no marking-capable alternative exists yet.'
              )}
            </p>
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {t(
                'admin.euAiAct.models.ackDialog.stillNonConforming',
                'The acknowledgement does not make the model conforming. It stays listed as non-conforming here and in the compliance report.'
              )}
            </p>
          </>
        }
        label={t('admin.euAiAct.dialog.justification', 'Justification')}
        submitLabel={t('admin.euAiAct.models.ackDialog.submit', 'Record acknowledgement')}
        onSubmit={handleAcknowledge}
        onClose={() => setAckTarget(null)}
      />
    </div>
  );
}

export default ModelsTab;
