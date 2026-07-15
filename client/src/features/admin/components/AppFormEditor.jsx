import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import StarterPromptsSection from './app-form/StarterPromptsSection';
import ToolsConfigSection from './app-form/ToolsConfigSection';
import McpToolsConfigSection from './app-form/McpToolsConfigSection';
import SkillsConfigSection from './app-form/SkillsConfigSection';
import WorkflowsConfigSection from './app-form/WorkflowsConfigSection';
import SourcePicker from './SourcePicker';
import ResourceSelector from './ResourceSelector';
import IframeConfigSection from './app-form/IframeConfigSection';
import RedirectConfigSection from './app-form/RedirectConfigSection';
import Icon from '../../../shared/components/Icon';
import IconPicker from '../../../shared/components/IconPicker';
import UploadConfigSection from './app-form/UploadConfigSection';
import VariablesSection from './app-form/VariablesSection';
import WebSearchSection from './app-form/WebSearchSection';
import IAssistantSection from './app-form/IAssistantSection';
import TranscriptionSection from './app-form/TranscriptionSection';
import MagicPromptSection from './app-form/MagicPromptSection';
import ExportConfigSection from './app-form/ExportConfigSection';
import CompareModeSection from './app-form/CompareModeSection';
import { getLocalizedContent } from '../../../utils/localizeContent';
import {
  validateWithSchema,
  errorsToFieldErrors,
  isFieldRequired
} from '../../../utils/schemaValidation';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import AdminFormErrorSummary from './AdminFormErrorSummary';
import { FormValidationProvider } from './formValidationContext';
import { fetchTranscriptionModels } from '../../../api/endpoints/models';

// parseInt/parseFloat return NaN for cleared/invalid input; NaN serializes to
// null in JSON and is rejected by the strict server schema, so fall back to undefined.
function parseNumberOrUndefined(value, parser = parseFloat) {
  const n = parser(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * AppFormEditor - Form-based editor for app configuration
 * This component contains all the form fields for editing app configuration
 * and is designed to be integrated with the DualModeEditor component.
 *
 * @component
 * @param {Object} props - Component props
 * @param {Object} props.value - The app configuration object
 * @param {Function} props.onChange - Callback fired when configuration changes
 * @param {Function} props.onValidationChange - Callback fired when validation state changes
 * @param {Array} props.availableModels - Available AI models
 * @param {Object} props.uiConfig - UI configuration for categories etc.
 * @returns {React.Component} AppFormEditor component
 */
function AppFormEditor({
  value: app,
  onChange,
  onValidationChange,
  availableModels = [],
  uiConfig = null,
  jsonSchema
}) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [validationErrors, setValidationErrors] = useState({});
  // Tool ids sourced from MCP servers. Managed in a dedicated section and
  // excluded from the generic tools picker so they don't appear twice.
  const [mcpToolIds, setMcpToolIds] = useState([]);
  // Transcription models (modelType: 'transcription') for the transcription
  // section's model picker — fetched separately since the default models list
  // is chat-only.
  const [transcriptionModels, setTranscriptionModels] = useState([]);
  const featureFlags = useFeatureFlags();

  useEffect(() => {
    let active = true;
    fetchTranscriptionModels()
      .then(models => {
        if (active && Array.isArray(models)) setTranscriptionModels(models);
      })
      .catch(err => console.error('Failed to load transcription models:', err));
    return () => {
      active = false;
    };
  }, []);

  // Check if sources feature is enabled
  const isSourcesEnabled = featureFlags.isEnabled('sources', true);

  // Validation function
  const validateApp = appData => {
    let errors = {};

    // Use schema validation if available
    if (jsonSchema) {
      const validation = validateWithSchema(appData, jsonSchema);
      if (!validation.isValid) {
        errors = errorsToFieldErrors(validation.errors);
      }
    } else {
      // Fallback to manual validation if no schema
      if (!appData.id) {
        errors.id = t('admin.apps.edit.validation.idRequired', 'App ID is required');
      } else if (!/^[a-zA-Z0-9_-]+$/.test(appData.id)) {
        errors.id = t(
          'admin.apps.edit.validation.idInvalid',
          'App ID can only contain letters, numbers, hyphens, and underscores'
        );
      }

      if (!appData.name || !Object.keys(appData.name).length) {
        errors.name = t('admin.apps.edit.validation.nameRequired', 'App name is required');
      }
    }

    if (!appData.description || !Object.keys(appData.description).length) {
      errors.description = t(
        'admin.apps.edit.validation.descriptionRequired',
        'App description is required'
      );
    }

    // System instructions are required for chat-type apps
    const appType = appData.type || 'chat';
    if (appType === 'chat') {
      if (!appData.system || !Object.keys(appData.system).length) {
        errors.system = t(
          'admin.apps.edit.validation.systemRequired',
          'System instructions are required'
        );
      }
    }

    if (!appData.color) {
      errors.color = t('admin.apps.edit.validation.colorRequired', 'Color is required');
    } else if (!/^#[0-9A-Fa-f]{6}$/.test(appData.color)) {
      errors.color = t('admin.apps.edit.validation.colorInvalid', 'Color must be a valid hex code');
    }

    if (!appData.icon) {
      errors.icon = t('admin.apps.edit.validation.iconRequired', 'Icon is required');
    }

    setValidationErrors(errors);

    const isValid = Object.keys(errors).length === 0;
    if (onValidationChange) {
      onValidationChange({
        isValid,
        errors: Object.entries(errors).map(([field, message]) => ({
          field,
          message,
          severity: 'error'
        }))
      });
    }

    return isValid;
  };

  // Validate on app changes
  useEffect(() => {
    if (app) {
      validateApp(app);
    }
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [app, jsonSchema]);

  const handleInputChange = (field, value) => {
    const updatedApp = {
      ...app,
      [field]: value
    };
    onChange(updatedApp);
  };

  const handleLocalizedChange = (field, value) => {
    const updatedApp = {
      ...app,
      [field]: value
    };
    onChange(updatedApp);
  };

  const handleAllowedModelsChange = selectedModelIds => {
    const updatedApp = {
      ...app,
      allowedModels: selectedModelIds
    };
    onChange(updatedApp);
  };

  // Source handling functions
  const handleSourcesChange = selectedSourceIds => {
    const updatedApp = {
      ...app,
      sources: selectedSourceIds
    };
    onChange(updatedApp);
  };

  if (!app) {
    return (
      <div className="p-8 text-center text-gray-500">
        <Icon name="exclamation-triangle" className="h-12 w-12 mx-auto mb-4 text-gray-400" />
        <p className="text-lg font-medium">
          {t('admin.apps.edit.noAppData', 'No app data available')}
        </p>
      </div>
    );
  }

  const errorLabels = {
    id: t('admin.apps.edit.appId', 'App ID'),
    name: t('admin.apps.edit.name', 'Name'),
    description: t('admin.apps.edit.description', 'Description'),
    color: t('admin.apps.edit.color', 'Color'),
    icon: t('admin.apps.edit.icon', 'Icon'),
    system: t('admin.apps.edit.systemPrompt', 'System Prompt')
  };

  return (
    <FormValidationProvider errors={validationErrors}>
      <div className="app-form-editor space-y-6">
        <AdminFormErrorSummary
          errors={validationErrors}
          labels={errorLabels}
          title={t('admin.apps.edit.fixErrors', 'Please fix the following errors')}
        />
        {/* Basic Information */}
        <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
          <div className="md:grid md:grid-cols-3 md:gap-6">
            <div className="md:col-span-1">
              <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.basicInfo', 'Basic Information')}
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t('admin.apps.edit.basicInfoDesc', 'Basic app configuration and metadata')}
              </p>
            </div>
            <div className="mt-5 md:col-span-2 md:mt-0">
              <div className="grid grid-cols-6 gap-6">
                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.appId', 'App ID')}
                    {isFieldRequired('id', jsonSchema) && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </label>
                  <input
                    id="id"
                    type="text"
                    required={isFieldRequired('id', jsonSchema)}
                    value={app.id || ''}
                    onChange={e => handleInputChange('id', e.target.value)}
                    className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                      validationErrors.id ? 'border-red-300' : ''
                    }`}
                    aria-invalid={!!validationErrors.id || undefined}
                    aria-describedby={validationErrors.id ? 'id-error' : undefined}
                  />
                  {validationErrors.id && (
                    <p
                      id="id-error"
                      role="alert"
                      className="mt-1 text-sm text-red-600 dark:text-red-400"
                    >
                      {validationErrors.id}
                    </p>
                  )}
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.appType', 'App Type')}
                    <span className="text-red-500 ml-1">*</span>
                  </label>
                  <select
                    value={app.type || 'chat'}
                    onChange={e => handleInputChange('type', e.target.value)}
                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="chat">{t('admin.apps.edit.typeChat', 'Chat')}</option>
                    <option value="iframe">{t('admin.apps.edit.typeIframe', 'Iframe')}</option>
                    <option value="redirect">
                      {t('admin.apps.edit.typeRedirect', 'Redirect')}
                    </option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.appTypeHint',
                      'Chat apps use AI models, Iframe apps embed external content, Redirect apps open external links'
                    )}
                  </p>
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.order', 'Order')}
                  </label>
                  <input
                    type="number"
                    value={app.order || 0}
                    onChange={e => handleInputChange('order', parseInt(e.target.value) || 0)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.category', 'Category')}
                  </label>
                  <select
                    value={app.category || ''}
                    onChange={e => handleInputChange('category', e.target.value)}
                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="">
                      {t('admin.apps.edit.selectCategory', 'Select category...')}
                    </option>
                    {uiConfig?.appsList?.categories?.list
                      ?.filter(cat => cat.id !== 'all')
                      .map(category => (
                        <option key={category.id} value={category.id}>
                          {getLocalizedContent(category.name, currentLanguage)}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="col-span-6">
                  <DynamicLanguageEditor
                    label={
                      <span>
                        {t('admin.apps.edit.name', 'Name')}
                        <span className="text-red-500 ml-1">*</span>
                      </span>
                    }
                    value={app.name || {}}
                    onChange={value => handleLocalizedChange('name', value)}
                    required={true}
                    placeholder={{
                      en: 'Enter app name in English',
                      de: 'App-Name auf Deutsch eingeben'
                    }}
                    error={validationErrors.name}
                    name="name"
                  />
                </div>

                <div className="col-span-6">
                  <DynamicLanguageEditor
                    label={
                      <span>
                        {t('admin.apps.edit.description', 'Description')}
                        <span className="text-red-500 ml-1">*</span>
                      </span>
                    }
                    value={app.description || {}}
                    onChange={value => handleLocalizedChange('description', value)}
                    required={true}
                    type="textarea"
                    placeholder={{
                      en: 'Enter app description in English',
                      de: 'App-Beschreibung auf Deutsch eingeben'
                    }}
                    error={validationErrors.description}
                    name="description"
                  />
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.color', 'Color')}
                    <span className="text-red-500 ml-1">*</span>
                  </label>
                  <input
                    id="color"
                    type="color"
                    value={app.color || '#4F46E5'}
                    onChange={e => handleInputChange('color', e.target.value)}
                    className={`mt-1 block w-full h-10 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                      validationErrors.color ? 'border-red-300' : ''
                    }`}
                    aria-invalid={!!validationErrors.color || undefined}
                    aria-describedby={validationErrors.color ? 'color-error' : undefined}
                  />
                  {validationErrors.color && (
                    <p
                      id="color-error"
                      role="alert"
                      className="mt-1 text-sm text-red-600 dark:text-red-400"
                    >
                      {validationErrors.color}
                    </p>
                  )}
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.icon', 'Icon')}
                    <span className="text-red-500 ml-1">*</span>
                  </label>
                  <div data-field="icon">
                    <IconPicker
                      value={app.icon || ''}
                      onChange={value => handleInputChange('icon', value)}
                      error={validationErrors.icon}
                      className="mt-1"
                    />
                  </div>
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.preferredModel', 'Preferred Model')}
                  </label>
                  <select
                    value={app.preferredModel || ''}
                    onChange={e => handleInputChange('preferredModel', e.target.value)}
                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="">{t('admin.apps.edit.selectModel', 'Select model...')}</option>
                    {availableModels.map(model => (
                      <option key={model.id} value={model.id}>
                        {getLocalizedContent(model.name, currentLanguage)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-span-6">
                  <ResourceSelector
                    label={t('admin.apps.edit.allowedModels', 'Allowed Models')}
                    resources={availableModels}
                    selectedResources={app.allowedModels || []}
                    onSelectionChange={handleAllowedModelsChange}
                    allowWildcard={false}
                    placeholder={t('admin.apps.edit.searchModels', 'Search models to add...')}
                    emptyMessage={t(
                      'admin.apps.edit.noModelsSelected',
                      'No restriction — all available models can be used with this app'
                    )}
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.allowedModelsHint',
                      'Restrict which models users can select for this app. Leave empty to allow all models.'
                    )}
                  </p>
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.temperature', 'Temperature')}
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={app.preferredTemperature || 0.7}
                    onChange={e =>
                      handleInputChange(
                        'preferredTemperature',
                        parseNumberOrUndefined(e.target.value)
                      )
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.outputFormat', 'Output Format')}
                  </label>
                  <select
                    value={app.preferredOutputFormat || 'markdown'}
                    onChange={e => handleInputChange('preferredOutputFormat', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  >
                    <option value="markdown">{t('appConfig.markdown', 'Markdown')}</option>
                    <option value="text">{t('appConfig.plainText', 'Plain Text')}</option>
                    <option value="json">{t('appConfig.json', 'JSON')}</option>
                    <option value="html">{t('appConfig.html', 'HTML')}</option>
                  </select>
                </div>

                <div className="col-span-6">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={app.enabled !== false}
                      onChange={e => handleInputChange('enabled', e.target.checked)}
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                      {t('admin.apps.edit.enabled', 'Enabled')}
                    </label>
                  </div>
                </div>

                {/* Auto-start - Only for chat apps */}
                {(app.type === 'chat' || !app.type) && (
                  <div className="col-span-6">
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.autoStart === true}
                        onChange={e => handleInputChange('autoStart', e.target.checked)}
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t('admin.apps.edit.autoStart', 'Auto-start conversation')}
                      </label>
                    </div>
                    <p className="mt-1 ml-6 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.apps.edit.autoStartHelp',
                        'When enabled, the app will automatically start the conversation when the chat is opened or reset'
                      )}
                    </p>
                  </div>
                )}

                {/* Ephemeral chat - Only for chat apps */}
                {(app.type === 'chat' || !app.type) && (
                  <div className="col-span-6">
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.ephemeral === true}
                        onChange={e => handleInputChange('ephemeral', e.target.checked)}
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t('admin.apps.edit.ephemeral', 'Ephemeral chat')}
                      </label>
                    </div>
                    <p className="mt-1 ml-6 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.apps.edit.ephemeralHelp',
                        'When enabled, the chat is never stored. Messages exist only while the chat is open and are discarded when you switch apps or reload.'
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Type-specific Configuration */}
        {(app.type === 'chat' || !app.type) && (
          <>
            {/* System Instructions - Only for chat apps */}
            <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
              <div className="md:grid md:grid-cols-3 md:gap-6">
                <div className="md:col-span-1">
                  <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
                    {t('admin.apps.edit.systemInstructions', 'System Instructions')}
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.systemInstructionsDesc',
                      'System prompts that define the app behavior'
                    )}
                  </p>
                </div>
                <div className="mt-5 md:col-span-2 md:mt-0">
                  <DynamicLanguageEditor
                    label={
                      <span>
                        {t('admin.apps.edit.systemInstructions', 'System Instructions')}
                        <span className="text-red-500 ml-1">*</span>
                      </span>
                    }
                    value={app.system || {}}
                    onChange={value => handleLocalizedChange('system', value)}
                    type="textarea"
                    placeholder={{
                      en: 'Enter system instructions in English',
                      de: 'Systeminstruktionen auf Deutsch eingeben'
                    }}
                    className="mb-6"
                    error={validationErrors.system}
                    name="system"
                  />

                  <DynamicLanguageEditor
                    label={t('admin.apps.edit.messagePlaceholder', 'Message Placeholder')}
                    value={app.messagePlaceholder || {}}
                    onChange={value => handleLocalizedChange('messagePlaceholder', value)}
                    placeholder={{
                      en: 'Enter message placeholder in English',
                      de: 'Nachrichtenplatzhalter auf Deutsch eingeben'
                    }}
                    className="mb-6"
                  />

                  <DynamicLanguageEditor
                    label={t('admin.apps.edit.prompt', 'Prompt Template')}
                    value={app.prompt || {}}
                    onChange={value => handleLocalizedChange('prompt', value)}
                    type="textarea"
                    placeholder={{
                      en: 'Enter prompt template in English',
                      de: 'Prompt-Vorlage auf Deutsch eingeben'
                    }}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {/* Iframe Configuration - Only for iframe apps */}
        {app.type === 'iframe' && (
          <IframeConfigSection app={app} onChange={handleInputChange} t={t} />
        )}

        {/* Redirect Configuration - Only for redirect apps */}
        {app.type === 'redirect' && (
          <RedirectConfigSection app={app} onChange={handleInputChange} t={t} />
        )}

        {/* Chat-specific sections - Only show for chat apps */}
        {(app.type === 'chat' || !app.type) && (
          <>
            {/* Web Search Configuration */}
            <WebSearchSection app={app} onChange={onChange} />

            {/* iAssistant Configuration */}
            <IAssistantSection app={app} onChange={onChange} />

            {/* Tools Configuration */}
            <ToolsConfigSection
              selectedTools={app.tools || []}
              onToolsChange={tools => handleInputChange('tools', tools)}
              mcpToolIds={mcpToolIds}
            />

            {/* MCP Server Tools */}
            <McpToolsConfigSection
              selectedTools={app.tools || []}
              onToolsChange={tools => handleInputChange('tools', tools)}
              onMcpToolIdsChange={setMcpToolIds}
            />

            {/* Workflows Configuration */}
            {featureFlags.isEnabled('workflows', true) && (
              <WorkflowsConfigSection
                selectedWorkflows={app.workflows || []}
                onWorkflowsChange={workflows => handleInputChange('workflows', workflows)}
              />
            )}

            {/* Skills Configuration */}
            {featureFlags.isEnabled('skills', false) && (
              <SkillsConfigSection
                selectedSkills={app.skills || []}
                onSkillsChange={skills => handleInputChange('skills', skills)}
              />
            )}

            {/* Variables Configuration */}
            <VariablesSection app={app} onChange={onChange} />

            {/* Starter Prompts */}
            <StarterPromptsSection app={app} onChange={onChange} />

            {/* Upload Configuration */}
            <UploadConfigSection
              app={app}
              onChange={handleInputChange}
              t={t}
              parseNumberOrUndefined={parseNumberOrUndefined}
            />

            {/* Transcription Configuration */}
            <TranscriptionSection
              app={app}
              onChange={handleInputChange}
              t={t}
              currentLanguage={currentLanguage}
              transcriptionModels={transcriptionModels}
              parseNumberOrUndefined={parseNumberOrUndefined}
            />

            {/* Magic Prompt Configuration */}
            <MagicPromptSection app={app} onChange={onChange} availableModels={availableModels} />

            {/* Export Configuration */}
            <ExportConfigSection app={app} onChange={onChange} />

            {/* Compare Mode Configuration */}
            <CompareModeSection app={app} onChange={onChange} />

            {/* Input Mode & Microphone Configuration */}
            <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
              <div className="md:grid md:grid-cols-3 md:gap-6">
                <div className="md:col-span-1">
                  <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
                    {t('admin.apps.edit.inputMode', 'Input Mode & Microphone')}
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.apps.edit.inputModeDesc',
                      'Configure input methods and voice recognition'
                    )}
                  </p>
                </div>
                <div className="mt-5 md:col-span-2 md:mt-0">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.apps.edit.inputType', 'Input Type')}
                      </label>
                      <select
                        value={app.inputMode?.type || 'multiline'}
                        onChange={e =>
                          handleInputChange('inputMode', {
                            ...app.inputMode,
                            type: e.target.value
                          })
                        }
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      >
                        <option value="singleline">
                          {t('admin.apps.edit.singleLine', 'Single Line')}
                        </option>
                        <option value="multiline">
                          {t('admin.apps.edit.multiLine', 'Multi Line')}
                        </option>
                      </select>
                    </div>

                    {app.inputMode?.type === 'multiline' && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                          {t('admin.apps.edit.textareaRows', 'Textarea Rows')}
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="20"
                          value={app.inputMode?.rows || 5}
                          onChange={e =>
                            handleInputChange('inputMode', {
                              ...app.inputMode,
                              rows: parseNumberOrUndefined(e.target.value, parseInt)
                            })
                          }
                          className="mt-1 block w-20 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                        />
                      </div>
                    )}

                    <div>
                      <div className="flex items-center mb-2">
                        <input
                          type="checkbox"
                          checked={app.inputMode?.microphone?.enabled !== false}
                          onChange={e =>
                            handleInputChange('inputMode', {
                              ...app.inputMode,
                              microphone: {
                                ...app.inputMode?.microphone,
                                enabled: e.target.checked
                              }
                            })
                          }
                          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                        />
                        <label className="ml-2 block text-sm font-medium text-gray-900">
                          {t('admin.apps.edit.enableMicrophone', 'Enable Microphone')}
                        </label>
                      </div>

                      {app.inputMode?.microphone?.enabled && (
                        <div className="space-y-3 pl-6">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                              {t('admin.apps.edit.microphoneMode', 'Microphone Mode')}
                            </label>
                            <select
                              value={app.inputMode?.microphone?.mode || 'manual'}
                              onChange={e =>
                                handleInputChange('inputMode', {
                                  ...app.inputMode,
                                  microphone: { ...app.inputMode?.microphone, mode: e.target.value }
                                })
                              }
                              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                            >
                              <option value="manual">
                                {t('admin.apps.edit.manualMode', 'Manual (Click to Record)')}
                              </option>
                              <option value="automatic">
                                {t('admin.apps.edit.automaticMode', 'Automatic (Voice Activation)')}
                              </option>
                            </select>
                          </div>

                          <div className="flex items-center">
                            <input
                              type="checkbox"
                              checked={app.inputMode?.microphone?.showTranscript !== false}
                              onChange={e =>
                                handleInputChange('inputMode', {
                                  ...app.inputMode,
                                  microphone: {
                                    ...app.inputMode?.microphone,
                                    showTranscript: e.target.checked
                                  }
                                })
                              }
                              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                            />
                            <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                              {t('admin.apps.edit.showTranscript', 'Show Transcript')}
                            </label>
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t(
                          'admin.apps.edit.speechRecognitionService',
                          'Speech Recognition Service'
                        )}
                      </label>
                      <select
                        value={app.settings?.speechRecognition?.service || 'default'}
                        onChange={e =>
                          handleInputChange('settings', {
                            ...app.settings,
                            speechRecognition: {
                              ...app.settings?.speechRecognition,
                              service: e.target.value
                            }
                          })
                        }
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                      >
                        <option value="default">
                          {t('admin.apps.edit.defaultService', 'Default (Browser)')}
                        </option>
                        <option value="azure">
                          {t('admin.apps.edit.azureService', 'Azure Speech')}
                        </option>
                        <option value="vllm-realtime">
                          {t(
                            'admin.apps.edit.vllmRealtimeService',
                            'vLLM Realtime (server-proxied)'
                          )}
                        </option>
                        <option value="custom">
                          {t('admin.apps.edit.customService', 'Custom Service')}
                        </option>
                      </select>
                      {app.settings?.speechRecognition?.service === 'vllm-realtime' && (
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {t(
                            'admin.apps.edit.vllmRealtimeHint',
                            'Streams microphone audio to the iHub server, which proxies it to the vLLM realtime endpoint configured in platform.json (speech.realtime).'
                          )}
                        </p>
                      )}
                    </div>

                    {(app.settings?.speechRecognition?.service === 'custom' ||
                      app.settings?.speechRecognition?.service === 'azure') && (
                      <div className="pl-6">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                          {t('admin.apps.edit.customServiceHost', 'Custom Service Host')}
                        </label>
                        <input
                          type="url"
                          value={app.settings?.speechRecognition?.host || ''}
                          onChange={e =>
                            handleInputChange('settings', {
                              ...app.settings,
                              speechRecognition: {
                                ...app.settings?.speechRecognition,
                                host: e.target.value
                              }
                            })
                          }
                          placeholder="https://your-speech-service.com"
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Sources Configuration - Only show if sources feature is enabled */}
            {isSourcesEnabled && (
              <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
                <div className="md:grid md:grid-cols-3 md:gap-6">
                  <div className="md:col-span-1">
                    <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
                      {t('admin.apps.edit.sources', 'Sources Configuration')}
                    </h3>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.apps.edit.sourcesDesc',
                        'Configure data sources that provide content to this app'
                      )}
                    </p>
                  </div>
                  <div className="mt-5 md:col-span-2 md:mt-0">
                    <div className="space-y-6">
                      {/* Source References */}
                      <div>
                        <p className="text-sm text-gray-600 mb-4">
                          {t(
                            'admin.apps.edit.sourcesDesc',
                            'Select data sources configured in the admin interface to provide content to this app'
                          )}
                        </p>
                        <SourcePicker
                          value={app.sources || []}
                          onChange={handleSourcesChange}
                          allowMultiple={true}
                          className="mb-4"
                        />
                      </div>

                      {/* Sources Summary */}
                      {app.sources && app.sources.length > 0 && (
                        <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                          <div className="flex">
                            <div className="flex-shrink-0">
                              <Icon name="information-circle" className="h-5 w-5 text-blue-400" />
                            </div>
                            <div className="ml-3">
                              <h3 className="text-sm font-medium text-blue-800">
                                {t('admin.apps.edit.sourcesConfigured', 'Sources Configured')}
                              </h3>
                              <div className="mt-2 text-sm text-blue-700">
                                <p>
                                  {t(
                                    'admin.apps.edit.sourcesCount',
                                    'This app has {{count}} source(s) configured:',
                                    { count: app.sources.length }
                                  )}
                                </p>
                                <ul className="list-disc list-inside mt-1 space-y-1">
                                  {app.sources.map((sourceId, index) => (
                                    <li key={`source-${index}`}>
                                      <span className="font-mono text-xs bg-blue-100 px-1 rounded">
                                        {sourceId}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                <p className="mt-2 text-xs">
                                  {t(
                                    'admin.apps.edit.sourcesUsage',
                                    'Sources will be loaded and their content made available via {{sources}} template in system prompts.'
                                  )}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Settings Configuration */}
            <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
              <div className="md:grid md:grid-cols-3 md:gap-6">
                <div className="md:col-span-1">
                  <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
                    {t('admin.apps.edit.settings', 'User Settings')}
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {t('admin.apps.edit.settingsDesc', 'Configure which settings users can modify')}
                  </p>
                </div>
                <div className="mt-5 md:col-span-2 md:mt-0">
                  <div className="space-y-4">
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.settings?.model?.enabled !== false}
                        onChange={e =>
                          handleInputChange('settings', {
                            ...app.settings,
                            model: { enabled: e.target.checked }
                          })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t('admin.apps.edit.enableModelSelection', 'Enable Model Selection')}
                      </label>
                    </div>

                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.settings?.temperature?.enabled !== false}
                        onChange={e =>
                          handleInputChange('settings', {
                            ...app.settings,
                            temperature: { enabled: e.target.checked }
                          })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t(
                          'admin.apps.edit.enableTemperatureControl',
                          'Enable Temperature Control'
                        )}
                      </label>
                    </div>

                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.settings?.outputFormat?.enabled !== false}
                        onChange={e =>
                          handleInputChange('settings', {
                            ...app.settings,
                            outputFormat: { enabled: e.target.checked }
                          })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t('admin.apps.edit.enableOutputFormat', 'Enable Output Format Selection')}
                      </label>
                    </div>

                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.settings?.chatHistory?.enabled !== false}
                        onChange={e =>
                          handleInputChange('settings', {
                            ...app.settings,
                            chatHistory: { enabled: e.target.checked }
                          })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t('admin.apps.edit.enableChatHistory', 'Enable Chat History Control')}
                      </label>
                    </div>

                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        checked={app.settings?.style?.enabled !== false}
                        onChange={e =>
                          handleInputChange('settings', {
                            ...app.settings,
                            style: { enabled: e.target.checked }
                          })
                        }
                        className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                      />
                      <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                        {t('admin.apps.edit.enableStyleControl', 'Enable Style Control')}
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </FormValidationProvider>
  );
}

export default AppFormEditor;
