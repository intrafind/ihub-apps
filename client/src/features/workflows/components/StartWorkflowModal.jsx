import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { apiClient } from '../../../api/client';
import { fetchModels } from '../../../api/endpoints/models';
import WorkflowPreview from './WorkflowPreview';

/**
 * Renders a form field based on variable type
 */
function FormField({ variable, value, onChange, disabled, language }) {
  const label = getLocalizedContent(variable.label, language) || variable.name;
  const description = getLocalizedContent(variable.description, language);
  const placeholder = getLocalizedContent(variable.placeholder, language) || '';

  const baseInputClasses =
    'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white';

  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}
        {variable.required && <span className="text-red-500 ml-1">*</span>}
      </label>

      {variable.type === 'select' && variable.options ? (
        <select
          value={value || ''}
          onChange={e => onChange(variable.name, e.target.value)}
          disabled={disabled}
          className={baseInputClasses}
        >
          <option value="">{placeholder || 'Select...'}</option>
          {variable.options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {getLocalizedContent(opt.label, language) || opt.value}
            </option>
          ))}
        </select>
      ) : variable.type === 'textarea' ? (
        <textarea
          value={value || ''}
          onChange={e => onChange(variable.name, e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          rows={variable.rows || 3}
          className={baseInputClasses}
        />
      ) : variable.type === 'number' ? (
        <input
          type="number"
          value={value || ''}
          onChange={e => onChange(variable.name, e.target.value ? Number(e.target.value) : '')}
          disabled={disabled}
          placeholder={placeholder}
          min={variable.min}
          max={variable.max}
          step={variable.step}
          className={baseInputClasses}
        />
      ) : variable.type === 'date' ? (
        <input
          type="date"
          value={value || ''}
          onChange={e => onChange(variable.name, e.target.value)}
          disabled={disabled}
          className={baseInputClasses}
        />
      ) : variable.type === 'boolean' ? (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={value || false}
            onChange={e => onChange(variable.name, e.target.checked)}
            disabled={disabled}
            className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
          />
          <span className="text-sm text-gray-600 dark:text-gray-400">{description}</span>
        </label>
      ) : (
        // Default to text input
        <input
          type="text"
          value={value || ''}
          onChange={e => onChange(variable.name, e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          className={baseInputClasses}
        />
      )}

      {description && variable.type !== 'boolean' && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{description}</p>
      )}
    </div>
  );
}

/**
 * Modal for configuring and starting a workflow execution.
 *
 * @param {Object} props - Component props
 * @param {Object} props.workflow - Workflow definition to start
 * @param {boolean} props.isOpen - Whether modal is open
 * @param {Function} props.onClose - Callback to close modal
 * @param {Function} props.onStarted - Callback when workflow is started (receives execution data)
 */
function StartWorkflowModal({ workflow, isOpen, onClose, onStarted }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;

  const [initialData, setInitialData] = useState({});
  const [selectedModel, setSelectedModel] = useState('');
  const [availableModels, setAvailableModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Extract input variables from start node config
  const inputVariables = useMemo(() => {
    if (!workflow?.nodes) return [];
    const startNode = workflow.nodes.find(n => n.type === 'start');
    return startNode?.config?.inputVariables || [];
  }, [workflow]);

  // Check if workflow has agent nodes (needs model selection)
  const hasAgentNodes = useMemo(() => {
    if (!workflow?.nodes) return false;
    return workflow.nodes.some(n => n.type === 'agent');
  }, [workflow]);

  // Get allowed models from workflow config or use all available
  const allowedModels = useMemo(() => {
    if (!workflow?.allowedModels || workflow.allowedModels.length === 0) {
      return availableModels;
    }
    return availableModels.filter(m => workflow.allowedModels.includes(m.id));
  }, [workflow?.allowedModels, availableModels]);

  // Fetch available models when modal opens
  useEffect(() => {
    if (isOpen && hasAgentNodes && availableModels.length === 0) {
      setLoadingModels(true);
      fetchModels()
        .then(models => {
          // Filter to only enabled models
          const enabledModels = (models || []).filter(m => m.enabled !== false);
          setAvailableModels(enabledModels);

          // Set default model if workflow has a preferred model
          if (workflow?.preferredModel) {
            setSelectedModel(workflow.preferredModel);
          } else {
            // Or use the first default model
            const defaultModel = enabledModels.find(m => m.default);
            if (defaultModel) {
              setSelectedModel(defaultModel.id);
            }
          }
        })
        .catch(err => {
          console.error('Failed to fetch models:', err);
        })
        .finally(() => {
          setLoadingModels(false);
        });
    }
  }, [isOpen, hasAgentNodes, availableModels.length, workflow?.preferredModel]);

  // Check if any required fields are missing
  const missingRequired = useMemo(() => {
    return inputVariables
      .filter(v => v.required)
      .filter(
        v => !initialData[v.name] && initialData[v.name] !== 0 && initialData[v.name] !== false
      );
  }, [inputVariables, initialData]);

  if (!isOpen || !workflow) return null;

  const name = getLocalizedContent(workflow.name, currentLanguage) || workflow.id;
  const description = getLocalizedContent(workflow.description, currentLanguage) || '';

  const handleFieldChange = (fieldName, value) => {
    setInitialData(prev => ({
      ...prev,
      [fieldName]: value
    }));
    setError(null);
  };

  const handleStart = async () => {
    // Validate required fields
    if (missingRequired.length > 0) {
      const missingNames = missingRequired.map(
        v => getLocalizedContent(v.label, currentLanguage) || v.name
      );
      setError(
        t('workflows.startModal.missingRequired', 'Please fill in required fields: {{fields}}', {
          fields: missingNames.join(', ')
        })
      );
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // Include model selection in initial data if selected
      const dataToSend = selectedModel
        ? { ...initialData, _modelOverride: selectedModel }
        : initialData;

      const response = await apiClient.post(`/workflows/${workflow.id}/execute`, {
        initialData: dataToSend,
        options: {
          checkpointOnNode: true
        }
      });

      onStarted(response.data);
    } catch (err) {
      console.error('Failed to start workflow:', err);
      setError(
        err.response?.data?.error ||
          err.message ||
          t('workflows.startError', 'Failed to start workflow')
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setInitialData({});
      setSelectedModel('');
      setError(null);
      setShowAdvanced(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-900 rounded-full flex items-center justify-center">
                <Icon name="play" className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {t('workflows.startModal.title', 'Start Workflow')}
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">{name}</p>
              </div>
            </div>
            <button
              onClick={handleClose}
              disabled={submitting}
              className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition-colors"
            >
              <Icon name="x" className="w-6 h-6" />
            </button>
          </div>

          {/* Body - scrollable */}
          <div className="p-4 overflow-y-auto flex-1">
            {/* Description */}
            {description && (
              <p className="text-gray-600 dark:text-gray-300 text-sm mb-4">{description}</p>
            )}

            {/* Workflow structure preview */}
            <div className="mb-4">
              <WorkflowPreview workflow={workflow} />
            </div>

            {/* Model selector - show only if workflow has agent nodes */}
            {hasAgentNodes && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  <Icon name="cpu-chip" className="w-4 h-4 inline mr-1" />
                  {t('workflows.startModal.model', 'Model')}
                </label>
                {loadingModels ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <LoadingSpinner size="sm" />
                    {t('workflows.startModal.loadingModels', 'Loading models...')}
                  </div>
                ) : (
                  <select
                    value={selectedModel}
                    onChange={e => setSelectedModel(e.target.value)}
                    disabled={submitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  >
                    <option value="">
                      {t('workflows.startModal.defaultModel', 'Use workflow default')}
                    </option>
                    {allowedModels.map(model => (
                      <option key={model.id} value={model.id}>
                        {getLocalizedContent(model.name, currentLanguage) || model.id}
                        {model.default ? ` (${t('common.default', 'Default')})` : ''}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t(
                    'workflows.startModal.modelHelp',
                    'Select which AI model to use for this workflow'
                  )}
                </p>
              </div>
            )}

            {/* Dynamic form fields */}
            {inputVariables.length > 0 ? (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  {t('workflows.startModal.inputFields', 'Input')}
                </h3>
                {inputVariables.map(variable => (
                  <FormField
                    key={variable.name}
                    variable={variable}
                    value={initialData[variable.name]}
                    onChange={handleFieldChange}
                    disabled={submitting}
                    language={currentLanguage}
                  />
                ))}
              </div>
            ) : (
              // No input variables - show simple message input or just info
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('workflows.startModal.message', 'Message (optional)')}
                </label>
                <textarea
                  value={initialData.message || ''}
                  onChange={e => handleFieldChange('message', e.target.value)}
                  disabled={submitting}
                  rows={3}
                  placeholder={t(
                    'workflows.startModal.messagePlaceholder',
                    'Enter your message or leave empty to start with defaults...'
                  )}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>
            )}

            {/* Advanced: Raw JSON (collapsible) */}
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              >
                <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} className="w-4 h-4" />
                {t('workflows.startModal.advanced', 'Advanced: Raw JSON')}
              </button>

              {showAdvanced && (
                <div className="mt-2">
                  <textarea
                    value={JSON.stringify(initialData, null, 2)}
                    onChange={e => {
                      try {
                        setInitialData(JSON.parse(e.target.value));
                        setError(null);
                      } catch {
                        // Allow typing even if JSON is invalid temporarily
                      }
                    }}
                    disabled={submitting}
                    rows={6}
                    placeholder='{"key": "value"}'
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white font-mono text-sm"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t(
                      'workflows.startModal.advancedHelp',
                      'Edit raw JSON data directly. Changes here override form fields.'
                    )}
                  </p>
                </div>
              )}
            </div>

            {/* Workflow info */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 mb-4">
              <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
                <span>
                  <Icon name="cube" className="w-4 h-4 inline mr-1" />
                  {workflow.nodes?.length || 0} nodes
                </span>
                {workflow.version && <span>v{workflow.version}</span>}
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div className="p-3 bg-red-100 border border-red-300 rounded-lg text-red-700 text-sm mb-4">
                {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 p-4 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={handleClose}
              disabled={submitting}
              className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg font-medium transition-colors"
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              onClick={handleStart}
              disabled={submitting}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <LoadingSpinner size="sm" />
                  {t('workflows.startModal.starting', 'Starting...')}
                </>
              ) : (
                <>
                  <Icon name="play" className="w-4 h-4" />
                  {t('workflows.startModal.start', 'Start Workflow')}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StartWorkflowModal;
