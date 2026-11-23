// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

const FIELD =
  'mt-1 block w-full rounded-md border border-admin-control-border dark:border-admin-control-border-dark bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500';
const BADGE = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium';

function typeLabel(t, type) {
  const labels = {
    embedding: t('admin.models.import.types.embedding', 'Embedding'),
    rerank: t('admin.models.import.types.rerank', 'Reranker'),
    audio: t('admin.models.import.types.audio', 'Audio'),
    transcription: t('admin.models.import.types.transcription', 'Transcription'),
    tts: t('admin.models.import.types.tts', 'Text-to-speech'),
    image: t('admin.models.import.types.image', 'Image'),
    moderation: t('admin.models.import.types.moderation', 'Moderation'),
    other: t('admin.models.import.types.other', 'Not a chat model')
  };
  return labels[type] || type;
}

/** Token count for display: `128k`, `1M`, or a dash when the endpoint did not say. */
export function formatTokens(value) {
  if (!value) return '—';
  if (value >= 1000000) return `${Math.round(value / 100000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/**
 * The table of models an endpoint lists (`POST /admin/models/_discover`), with
 * a checkbox, the detected context window, vision and tool support, and the
 * iHub id (plus the Azure deployment name) each picked model gets. Shared by
 * the "Import from URL" dialog and the "Connect a model provider" flow; the
 * owner keeps the selection, ids and deployments and passes them in.
 *
 * @param {Object} props
 * @param {Array<Object>} props.models - Rows to show (already filtered by search)
 * @param {Record<string, boolean>} props.selected - Picked rows by remote model id
 * @param {(modelId: string, checked: boolean) => void} props.onToggle
 * @param {boolean} props.allSelected - Whether "select all" is ticked
 * @param {() => void} props.onToggleAll
 * @param {(model: Object) => string} props.targetIdOf - iHub id a row gets
 * @param {(modelId: string, id: string) => void} props.onIdChange
 * @param {Record<string, string>} props.idProblems - Problem per remote model id
 * @param {(problem: string) => string} props.problemText
 * @param {boolean} [props.isAzure]
 * @param {Record<string, string>} [props.deployments]
 * @param {(model: Object) => string} [props.deploymentOf]
 * @param {(modelId: string, name: string) => void} [props.onDeploymentChange]
 */
function ModelPickList({
  models,
  selected,
  onToggle,
  allSelected,
  onToggleAll,
  targetIdOf,
  onIdChange,
  idProblems,
  problemText,
  isAzure = false,
  deployments = {},
  deploymentOf = model => model.id,
  onDeploymentChange = () => {}
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900">
          <tr>
            <th className="px-3 py-2 w-8">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                aria-label={t('admin.models.import.selectAll', 'Select all chat models')}
                className="h-4 w-4 rounded-sm border border-gray-300 text-indigo-600"
              />
            </th>
            <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
              {t('admin.models.import.model', 'Model')}
            </th>
            <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400 hidden sm:table-cell">
              {t('admin.models.import.context', 'Context')}
            </th>
            {isAzure && (
              <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
                {t('admin.models.import.deploymentName', 'Deployment name')}
              </th>
            )}
            <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">
              {t('admin.models.import.targetId', 'iHub model ID')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {models.map(model => {
            const checked = Boolean(selected[model.id]);
            const problem = checked ? idProblems[model.id] : null;
            return (
              <tr key={model.id} className={checked ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : ''}>
                <td className="px-3 py-2 align-top">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={model.unsupported}
                    onChange={e => onToggle(model.id, e.target.checked)}
                    aria-label={model.name}
                    className="mt-1 h-4 w-4 rounded-sm border border-gray-300 text-indigo-600"
                  />
                </td>
                <td className="px-3 py-2 align-top">
                  <div className="font-medium text-gray-900 dark:text-gray-100">{model.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 break-all">
                    {model.id}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {model.type !== 'chat' && (
                      <span
                        className={`${BADGE} bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300`}
                      >
                        {typeLabel(t, model.type)}
                      </span>
                    )}
                    {model.unsupported && (
                      <span
                        className={`${BADGE} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300`}
                      >
                        {t(
                          'admin.models.import.unsupported',
                          'iHub cannot run this model from this provider'
                        )}
                      </span>
                    )}
                    {model.supportsVision && (
                      <span
                        className={`${BADGE} bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300`}
                      >
                        {t('admin.models.import.vision', 'Vision')}
                      </span>
                    )}
                    {model.supportsTools === true && (
                      <span
                        className={`${BADGE} bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300`}
                      >
                        {t('admin.models.import.tools', 'Tools')}
                      </span>
                    )}
                    {model.existingModelId && (
                      <span
                        className={`${BADGE} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300`}
                      >
                        {t('admin.models.import.alreadyAdded', 'Already added as {{id}}', {
                          id: model.existingModelId
                        })}
                      </span>
                    )}
                    {model.endOfLife && (
                      <span
                        className={`${BADGE} bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300`}
                      >
                        {t('admin.models.import.endOfLife', 'End of life: {{date}}', {
                          date: model.endOfLife.slice(0, 10)
                        })}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-gray-700 dark:text-gray-300 hidden sm:table-cell">
                  {formatTokens(model.contextWindow)}
                </td>
                {isAzure && (
                  <td className="px-3 py-2 align-top">
                    <input
                      type="text"
                      value={deployments[model.id] ?? model.id}
                      onChange={e => onDeploymentChange(model.id, e.target.value)}
                      disabled={!checked}
                      aria-label={t(
                        'admin.models.import.deploymentNameFor',
                        'Deployment name for {{name}}',
                        { name: model.name }
                      )}
                      className={`${FIELD} mt-0 disabled:opacity-60 ${
                        checked && !deploymentOf(model) ? 'border-red-400' : ''
                      }`}
                    />
                  </td>
                )}
                <td className="px-3 py-2 align-top">
                  <input
                    type="text"
                    value={targetIdOf(model)}
                    onChange={e => onIdChange(model.id, e.target.value)}
                    disabled={!checked}
                    aria-label={t('admin.models.import.targetIdFor', 'iHub model ID for {{name}}', {
                      name: model.name
                    })}
                    className={`${FIELD} mt-0 disabled:opacity-60 ${problem ? 'border-red-400' : ''}`}
                  />
                  {problem && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      {problemText(problem)}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default ModelPickList;
