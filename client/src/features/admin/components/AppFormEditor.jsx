import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import StarterPromptsSection from './app-form/StarterPromptsSection';
import ToolsConfigSection from './app-form/ToolsConfigSection';
import McpToolsConfigSection from './app-form/McpToolsConfigSection';
import SkillsConfigSection from './app-form/SkillsConfigSection';
import WorkflowsConfigSection from './app-form/WorkflowsConfigSection';
import IframeConfigSection from './app-form/IframeConfigSection';
import RedirectConfigSection from './app-form/RedirectConfigSection';
import Icon from '../../../shared/components/Icon';
import UploadConfigSection from './app-form/UploadConfigSection';
import VariablesSection from './app-form/VariablesSection';
import WebSearchSection from './app-form/WebSearchSection';
import IAssistantSection from './app-form/IAssistantSection';
import TranscriptionSection from './app-form/TranscriptionSection';
import MagicPromptSection from './app-form/MagicPromptSection';
import ExportConfigSection from './app-form/ExportConfigSection';
import CompareModeSection from './app-form/CompareModeSection';
import SystemInstructionsSection from './app-form/SystemInstructionsSection';
import SourcesConfigSection from './app-form/SourcesConfigSection';
import SettingsConfigSection from './app-form/SettingsConfigSection';
import { validateWithSchema, errorsToFieldErrors } from '../../../utils/schemaValidation';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import AdminFormErrorSummary from './AdminFormErrorSummary';
import { FormValidationProvider } from './formValidationContext';
import { fetchTranscriptionModels } from '../../../api/endpoints/models';
import BasicInfoSection from './app-form/BasicInfoSection';
import InputModeSection from './app-form/InputModeSection';
import parseNumberOrUndefined from '../utils/parseNumberOrUndefined';

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
        <BasicInfoSection
          app={app}
          onChange={onChange}
          t={t}
          currentLanguage={currentLanguage}
          uiConfig={uiConfig}
          availableModels={availableModels}
          validationErrors={validationErrors}
          jsonSchema={jsonSchema}
        />

        {/* Type-specific Configuration */}
        {(app.type === 'chat' || !app.type) && (
          <>
            {/* System Instructions - Only for chat apps */}
            <SystemInstructionsSection
              app={app}
              onChange={onChange}
              t={t}
              validationErrors={validationErrors}
            />
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

            <InputModeSection app={app} onChange={onChange} t={t} />

            {/* Sources Configuration - Only show if sources feature is enabled */}
            {isSourcesEnabled && <SourcesConfigSection app={app} onChange={onChange} t={t} />}

            {/* Settings Configuration */}
            <SettingsConfigSection app={app} onChange={onChange} t={t} />
          </>
        )}
      </div>
    </FormValidationProvider>
  );
}

export default AppFormEditor;
