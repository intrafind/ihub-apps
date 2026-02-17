import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

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

  const handleSubmit = async () => {
    if (!selectedOption) return;

    setSubmitting(true);
    setError(null);

    try {
      await onRespond({
        checkpointId: checkpoint.id,
        response: selectedOption,
        data: Object.keys(formData).length > 0 ? formData : undefined
      });
    } catch (err) {
      console.error('Failed to submit checkpoint response:', err);
      setError(err.message || t('workflows.checkpoint.submitError', 'Failed to submit response'));
    } finally {
      setSubmitting(false);
    }
  };

  // Determine button style based on option.style
  const getButtonClasses = (option, isSelected) => {
    const baseClasses =
      'flex-1 px-4 py-3 rounded-lg font-medium transition-all border-2 text-center';

    if (isSelected) {
      switch (option.style) {
        case 'primary':
          return `${baseClasses} bg-indigo-600 text-white border-indigo-600`;
        case 'danger':
          return `${baseClasses} bg-red-600 text-white border-red-600`;
        default:
          return `${baseClasses} bg-gray-600 text-white border-gray-600`;
      }
    }

    switch (option.style) {
      case 'primary':
        return `${baseClasses} bg-white text-indigo-600 border-indigo-300 hover:border-indigo-600`;
      case 'danger':
        return `${baseClasses} bg-white text-red-600 border-red-300 hover:border-red-600`;
      default:
        return `${baseClasses} bg-white text-gray-700 border-gray-300 hover:border-gray-500`;
    }
  };

  return (
    <div className="bg-gradient-to-br from-yellow-50 to-orange-50 dark:from-yellow-900/20 dark:to-orange-900/20 border-l-4 border-yellow-400 rounded-lg p-6 shadow-md">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 bg-yellow-400 rounded-full flex items-center justify-center">
          <Icon name="hand-raised" className="w-6 h-6 text-white" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {checkpoint.nodeName || t('workflows.checkpoint.title', 'Action Required')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('workflows.checkpoint.subtitle', 'This workflow needs your input to continue')}
          </p>
        </div>
      </div>

      {/* Message */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-4 shadow-sm">
        <p className="text-gray-700 dark:text-gray-300">{checkpoint.message}</p>
      </div>

      {/* Display Data (if showData was specified) */}
      {displayData && Object.keys(displayData).length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('workflows.checkpoint.relevantData', 'Relevant Data')}
          </h4>
          <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-3 max-h-48 overflow-auto">
            <pre className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
              {JSON.stringify(displayData, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Options */}
      {checkpoint.options && checkpoint.options.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('workflows.checkpoint.selectOption', 'Select an option')}
          </h4>
          <div className="flex flex-wrap gap-3">
            {checkpoint.options.map(option => (
              <button
                key={option.value}
                onClick={() => setSelectedOption(option.value)}
                disabled={submitting}
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

      {/* Input Schema Form (basic implementation) */}
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
                    <span className="text-red-500 ml-1">*</span>
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

      {/* Error message */}
      {error && (
        <div className="mb-4 p-3 bg-red-100 border border-red-300 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={!selectedOption || submitting}
        className={`w-full py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
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
            <Icon name="check" className="w-5 h-5" />
            {t('workflows.checkpoint.submit', 'Submit Response')}
          </>
        )}
      </button>

      {/* Timeout indicator */}
      {checkpoint.expiresAt && (
        <div className="mt-3 text-sm text-gray-500 dark:text-gray-400 text-center">
          <Icon name="clock" className="w-4 h-4 inline mr-1" />
          {t('workflows.checkpoint.expiresAt', 'Expires')}:{' '}
          {new Date(checkpoint.expiresAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}

export default HumanCheckpoint;
