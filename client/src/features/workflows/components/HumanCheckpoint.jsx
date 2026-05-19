import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { useTechnicalDetailsToggle } from '../hooks/useTechnicalDetailsToggle';
import { markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';

const LONG_STRING_THRESHOLD = 500;

/**
 * Renders a single value from `displayData` in a human-friendly way:
 *  - markdown strings render formatted
 *  - long strings truncate with a "Show full" toggle
 *  - arrays/objects show a compact summary that expands on demand
 *  - primitives render as text
 */
function DisplayValue({ fieldKey, value }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (value === null || value === undefined || value === '') {
    return (
      <span className="text-gray-400 dark:text-gray-500 italic">
        {t('workflows.checkpoint.displayDataEmptyValue', '(empty)')}
      </span>
    );
  }

  if (typeof value === 'boolean') {
    return <span className="font-mono">{value ? 'true' : 'false'}</span>;
  }

  if (typeof value === 'number') {
    return <span className="font-mono">{String(value)}</span>;
  }

  if (typeof value === 'string') {
    const isLong = value.length > LONG_STRING_THRESHOLD;
    const shown = expanded || !isLong ? value : value.substring(0, LONG_STRING_THRESHOLD) + '…';
    if (isMarkdown(shown)) {
      const html = markdownToHtml(shown);
      return (
        <div>
          <div
            className="prose dark:prose-invert prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(prev => !prev)}
              className="mt-2 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium"
            >
              {expanded
                ? t('workflows.checkpoint.longValueShowLess', 'Show less')
                : t('workflows.checkpoint.longValueShowMore', 'Show full value')}
            </button>
          )}
        </div>
      );
    }
    return (
      <div>
        <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
          {shown}
        </div>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="mt-1 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium"
          >
            {expanded
              ? t('workflows.checkpoint.longValueShowLess', 'Show less')
              : t('workflows.checkpoint.longValueShowMore', 'Show full value')}
          </button>
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    if (!expanded) {
      return (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          aria-label={`Expand ${fieldKey}`}
        >
          <Icon name="chevron-down" className="w-3 h-3" aria-hidden="true" />[{value.length}{' '}
          {value.length === 1 ? 'item' : 'items'}]
        </button>
      );
    }
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 hover:underline mb-2"
        >
          <Icon name="chevron-up" className="w-3 h-3" aria-hidden="true" />
          Collapse
        </button>
        <ol className="list-decimal list-inside text-sm text-gray-800 dark:text-gray-200 space-y-1">
          {value.map((item, idx) => (
            <li key={idx} className="break-words">
              {typeof item === 'object' ? JSON.stringify(item) : String(item)}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!expanded) {
      return (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          aria-label={`Expand ${fieldKey}`}
        >
          <Icon name="chevron-down" className="w-3 h-3" aria-hidden="true" />
          {`{${entries.length} ${entries.length === 1 ? 'field' : 'fields'}}`}
        </button>
      );
    }
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 hover:underline mb-2"
        >
          <Icon name="chevron-up" className="w-3 h-3" aria-hidden="true" />
          Collapse
        </button>
        <dl className="text-sm text-gray-800 dark:text-gray-200 space-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="font-medium text-gray-600 dark:text-gray-400">{k}:</dt>
              <dd className="break-words">
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  return <span>{String(value)}</span>;
}

/**
 * Renders the `displayData` object as a key/value list. When the technical
 * details toggle is on, also shows the raw JSON for full inspection.
 */
function DisplayData({ displayData, showTechnical }) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  const entries = Object.entries(displayData);
  if (entries.length === 0) return null;

  return (
    <div className="mb-4">
      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
        {t('workflows.checkpoint.relevantData', 'Relevant Data')}
      </h4>
      <div className="bg-white/80 dark:bg-gray-800/60 rounded-lg p-3 space-y-3 max-h-96 overflow-y-auto border border-yellow-200 dark:border-yellow-800/40">
        {entries.map(([key, value]) => (
          <div key={key}>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
              {key.replace(/_/g, ' ')}
            </div>
            <DisplayValue fieldKey={key} value={value} />
          </div>
        ))}
      </div>

      {showTechnical && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowRaw(prev => !prev)}
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 inline-flex items-center gap-1"
          >
            <Icon
              name={showRaw ? 'chevron-up' : 'chevron-down'}
              className="w-3 h-3"
              aria-hidden="true"
            />
            {showRaw
              ? t('workflows.checkpoint.hideRawJson', 'Hide raw data')
              : t('workflows.checkpoint.showRawJson', 'Show raw data')}
          </button>
          {showRaw && (
            <pre className="mt-2 text-xs bg-gray-100 dark:bg-gray-900 rounded p-2 overflow-auto max-h-64 text-gray-800 dark:text-gray-200">
              {JSON.stringify(displayData, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Component for displaying and responding to human checkpoint requests.
 *
 * @param {Object} props - Component props
 * @param {Object} props.checkpoint - Checkpoint data from workflow
 * @param {Function} props.onRespond - Callback when user responds
 * @param {Object} [props.displayData] - Data to display to the user
 */
function HumanCheckpoint({ checkpoint, onRespond, displayData }) {
  const { t } = useTranslation();
  const [selectedOption, setSelectedOption] = useState(null);
  const [formData, setFormData] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [showTechnical] = useTechnicalDetailsToggle();

  const submitResponse = async optionValue => {
    setSubmitting(true);
    setError(null);

    try {
      await onRespond({
        checkpointId: checkpoint.id,
        response: optionValue,
        data: Object.keys(formData).length > 0 ? formData : undefined
      });
    } catch (err) {
      console.error('Failed to submit checkpoint response:', err);
      setError(err.message || t('workflows.checkpoint.submitError', 'Failed to submit response'));
    } finally {
      setSubmitting(false);
      setPendingConfirm(null);
    }
  };

  const handleSubmit = () => {
    if (!selectedOption) return;
    const option = checkpoint.options?.find(o => o.value === selectedOption);
    if (option?.style === 'danger') {
      setPendingConfirm(option);
      return;
    }
    submitResponse(selectedOption);
  };

  const getButtonClasses = (option, isSelected) => {
    const base =
      'flex-1 px-4 py-3 rounded-lg font-medium transition-all border-2 text-center focus:outline-none focus:ring-2 focus:ring-offset-2';

    if (isSelected) {
      switch (option.style) {
        case 'primary':
          return `${base} bg-indigo-600 text-white border-indigo-600 focus:ring-indigo-500`;
        case 'danger':
          return `${base} bg-red-600 text-white border-red-600 focus:ring-red-500`;
        default:
          return `${base} bg-gray-600 text-white border-gray-600 focus:ring-gray-500`;
      }
    }

    switch (option.style) {
      case 'primary':
        return `${base} bg-white dark:bg-gray-800 text-indigo-600 dark:text-indigo-300 border-indigo-300 dark:border-indigo-700 hover:border-indigo-600 focus:ring-indigo-500`;
      case 'danger':
        return `${base} bg-white dark:bg-gray-800 text-red-600 dark:text-red-300 border-red-300 dark:border-red-700 hover:border-red-600 focus:ring-red-500`;
      default:
        return `${base} bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:border-gray-500 focus:ring-gray-400`;
    }
  };

  return (
    <div className="bg-gradient-to-br from-yellow-50 to-orange-50 dark:from-yellow-900/20 dark:to-orange-900/20 border-l-4 border-yellow-400 rounded-lg p-6 shadow-md">
      <div className="flex items-center gap-3 mb-4">
        <div
          className="w-10 h-10 bg-yellow-400 rounded-full flex items-center justify-center flex-shrink-0"
          aria-hidden="true"
        >
          <Icon name="hand-raised" className="w-6 h-6 text-white" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {checkpoint.nodeName || t('workflows.checkpoint.title', 'Action Required')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t('workflows.checkpointNeedsInput', 'This workflow needs your input')}
          </p>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-4 shadow-sm">
        <p className="text-gray-700 dark:text-gray-300">{checkpoint.message}</p>
      </div>

      {displayData && Object.keys(displayData).length > 0 && (
        <DisplayData displayData={displayData} showTechnical={showTechnical} />
      )}

      {checkpoint.options && checkpoint.options.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('workflows.checkpoint.selectOption', 'Select an option')}
          </h4>
          <div className="flex flex-wrap gap-3">
            {checkpoint.options.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => setSelectedOption(option.value)}
                disabled={submitting}
                aria-pressed={selectedOption === option.value}
                className={getButtonClasses(option, selectedOption === option.value)}
              >
                {option.label}
                {option.description && (
                  <span className="block text-xs opacity-75 mt-1">{option.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {checkpoint.inputSchema && checkpoint.inputSchema.properties && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('workflows.checkpoint.additionalInfo', 'Additional Information')}
          </h4>
          <div className="space-y-3">
            {Object.entries(checkpoint.inputSchema.properties).map(([key, prop]) => (
              <div key={key}>
                <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                  {prop.title || key}
                  {checkpoint.inputSchema.required?.includes(key) && (
                    <span className="text-red-500 ml-1" aria-hidden="true">
                      *
                    </span>
                  )}
                </label>
                {prop.type === 'string' && prop.enum ? (
                  <select
                    value={formData[key] || ''}
                    onChange={e => setFormData(prev => ({ ...prev, [key]: e.target.value }))}
                    disabled={submitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  >
                    <option value="">Select...</option>
                    {prop.enum.map(val => (
                      <option key={val} value={val}>
                        {val}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={prop.type === 'number' ? 'number' : 'text'}
                    value={formData[key] || ''}
                    onChange={e => setFormData(prev => ({ ...prev, [key]: e.target.value }))}
                    disabled={submitting}
                    placeholder={prop.description}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-4 p-3 bg-red-100 border border-red-300 rounded-lg text-red-700 text-sm"
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!selectedOption || submitting}
        className={`w-full py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 ${
          !selectedOption || submitting
            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
            : 'bg-indigo-600 hover:bg-indigo-700 text-white'
        }`}
      >
        {submitting ? (
          <>
            <LoadingSpinner size="sm" />
            {t('workflows.checkpoint.submitting', 'Submitting...')}
          </>
        ) : (
          <>
            <Icon name="check" className="w-5 h-5" aria-hidden="true" />
            {t('workflows.checkpoint.submit', 'Submit Response')}
          </>
        )}
      </button>

      {checkpoint.expiresAt && (
        <div className="mt-3 text-sm text-gray-600 dark:text-gray-400 text-center">
          <Icon name="clock" className="w-4 h-4 inline mr-1" aria-hidden="true" />
          {t('workflows.checkpoint.expiresAt', 'Expires')}:{' '}
          {new Date(checkpoint.expiresAt).toLocaleString()}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!pendingConfirm}
        title={t('workflows.confirmDestructiveCheckpoint.title', 'Confirm action')}
        message={t(
          'workflows.confirmDestructiveCheckpoint.message',
          "This action can't be undone. Continue?"
        )}
        confirmLabel={pendingConfirm?.label}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={() => submitResponse(pendingConfirm.value)}
        onDeny={() => setPendingConfirm(null)}
      />
    </div>
  );
}

export default HumanCheckpoint;
