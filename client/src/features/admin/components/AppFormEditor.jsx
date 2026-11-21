// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import StarterPromptsSection from './app-form/StarterPromptsSection';
import UsageGuideSection from './app-form/UsageGuideSection';
import ToolsConfigSection from './app-form/ToolsConfigSection';
import IntegrationsConfigSection from './app-form/IntegrationsConfigSection';
import SkillsConfigSection from './app-form/SkillsConfigSection';
import WorkflowsConfigSection from './app-form/WorkflowsConfigSection';
import AppsConfigSection from './app-form/AppsConfigSection';
import IframeConfigSection from './app-form/IframeConfigSection';
import RedirectConfigSection from './app-form/RedirectConfigSection';
import Icon from '../../../shared/components/Icon';
import UploadConfigSection from './app-form/UploadConfigSection';
import VariablesSection from './app-form/VariablesSection';
import MagicPromptSection from './app-form/MagicPromptSection';
import ExportConfigSection from './app-form/ExportConfigSection';
import DocumentTemplateSection from './app-form/DocumentTemplateSection';
import CompareModeSection from './app-form/CompareModeSection';
import FeedbackSection from './app-form/FeedbackSection';
import AiNoticeSection from './app-form/AiNoticeSection';
import SystemInstructionsSection from './app-form/SystemInstructionsSection';
import ProjectsConfigSection from './app-form/ProjectsConfigSection';
import SettingsConfigSection from './app-form/SettingsConfigSection';
import ModelSection from './app-form/ModelSection';
import ChatBehaviourSection from './app-form/ChatBehaviourSection';
import EditorGroup from './app-form/EditorGroup';
import { AppFormLanguageProvider } from './app-form/AppLanguageField';
import { useEditorGroups } from './app-form/useEditorGroups';
import { validateWithSchema, errorsToFieldErrors } from '../../../utils/schemaValidation';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import AdminFormErrorSummary from './AdminFormErrorSummary';
import { FormValidationProvider } from '../../../shared/contexts/formValidationContext';
import useAdminTranscriptionModels from '../hooks/useAdminTranscriptionModels';
import useAdminTtsModels from '../hooks/useAdminTtsModels';
import BasicInfoSection from './app-form/BasicInfoSection';
import InputModeSection from './app-form/InputModeSection';
import parseNumberOrUndefined from '../utils/parseNumberOrUndefined';
import { primaryLanguageOf } from '../../../../../shared/appDefaults.js';

const NO_ERRORS = Object.freeze([]);

/** True when a localized text has text in at least one language. */
const hasText = value =>
  Boolean(value) &&
  typeof value === 'object' &&
  Object.values(value).some(text => typeof text === 'string' && text.trim() !== '');

/**
 * The form of the app editor: the sections of an app in the editor's groups
 * (`app-form/editorGroups.js`). Made for `DualModeEditor`.
 *
 * Every group stays mounted while it is collapsed, so validation and what is
 * saved do not depend on what is open. The group "Who can use this app" is
 * not part of the form; the page renders it.
 *
 * @param {object} props
 * @param {object} props.value - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @param {function({isValid: boolean, errors: Array<{field: string, message: string}>}): void} [props.onValidationChange]
 * @param {Array<object>} [props.availableModels] - The models the author may use.
 * @param {object|null} [props.uiConfig] - The UI configuration (categories).
 * @param {object} [props.jsonSchema] - The JSON schema of an app.
 * @param {object} [props.groups] - The state of `useEditorGroups`, when the
 *   page shares it with its index and save bar. Without it the form keeps its own.
 * @returns {JSX.Element}
 */
function AppFormEditor(props) {
  return props.groups ? <AppForm {...props} /> : <SelfGroupedAppForm {...props} />;
}

/** The form with a group state of its own, for a caller that shares none. */
function SelfGroupedAppForm({ onValidationChange, ...props }) {
  const { i18n } = useTranslation();
  const [errors, setErrors] = useState(NO_ERRORS);
  const { value: app, availableModels } = props;
  const extra = useMemo(
    () => ({ models: availableModels || [], language: i18n.language }),
    [availableModels, i18n.language]
  );
  const groups = useEditorGroups({ app, errors, extra });
  const handleValidationChange = useCallback(
    state => {
      setErrors(state.errors);
      onValidationChange?.(state);
    },
    [onValidationChange]
  );
  return <AppForm {...props} groups={groups} onValidationChange={handleValidationChange} />;
}

function AppForm({
  value: app,
  onChange,
  onValidationChange,
  availableModels = [],
  uiConfig = null,
  jsonSchema,
  groups
}) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [validationErrors, setValidationErrors] = useState({});
  const transcriptionModels = useAdminTranscriptionModels();
  const ttsModels = useAdminTtsModels();
  const featureFlags = useFeatureFlags();

  // Projects (#1036) can be linked only while the projects feature is enabled
  const isProjectsEnabled = featureFlags.isEnabled('projects', true);

  // The language the texts are edited in first. It is fixed per app, so that
  // it does not jump while the author empties and retypes the name.
  const languageKey = `${app?.id ?? ''}|${currentLanguage}`;
  const [primary, setPrimary] = useState(() => ({
    key: languageKey,
    language: primaryLanguageOf(app, currentLanguage)
  }));
  if (primary.key !== languageKey) {
    setPrimary({ key: languageKey, language: primaryLanguageOf(app, currentLanguage) });
  }

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
        errors.id = t('admin.apps.edit.validation.idRequired');
      } else if (!/^[a-zA-Z0-9_-]+$/.test(appData.id)) {
        errors.id = t('admin.apps.edit.validation.idInvalid');
      }
    }

    // A required text needs content in at least one language. One message per
    // field stands for it, in place of one per empty language.
    const requireText = (field, message) => {
      if (hasText(appData[field])) return;
      for (const key of Object.keys(errors)) {
        if (key.startsWith(`${field}.`)) delete errors[key];
      }
      errors[field] = message;
    };
    requireText('name', t('admin.apps.edit.validation.nameRequired'));
    requireText('description', t('admin.apps.edit.validation.descriptionRequired'));
    // Instructions are required for chat apps. A save drops a text without
    // content, so the server would not report it.
    if ((appData.type || 'chat') === 'chat') {
      requireText('system', t('admin.apps.edit.validation.systemRequired'));
    }

    if (!appData.color) {
      errors.color = t('admin.apps.edit.validation.colorRequired');
    } else if (!/^#[0-9A-Fa-f]{6}$/.test(appData.color)) {
      errors.color = t('admin.apps.edit.validation.colorInvalid');
    }

    if (!appData.icon) {
      errors.icon = t('admin.apps.edit.validation.iconRequired');
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
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        <Icon name="exclamation-triangle" className="h-12 w-12 mx-auto mb-4" />
        <p className="text-lg font-medium">{t('admin.apps.edit.noAppData')}</p>
      </div>
    );
  }

  const errorLabels = {
    id: t('admin.apps.edit.appId'),
    name: t('admin.apps.edit.name'),
    description: t('admin.apps.edit.description'),
    color: t('admin.apps.edit.color'),
    icon: t('admin.apps.edit.icon'),
    system: t('admin.apps.edit.systemPrompt'),
    prompt: t('admin.apps.edit.prompt'),
    messagePlaceholder: t('admin.apps.edit.messagePlaceholder'),
    variables: t('admin.apps.edit.variables'),
    starterPrompts: t('admin.apps.edit.starterPrompts')
  };

  /**
   * A link of the error summary leads to a field. Its group has to be open
   * before the summary looks the field up and moves the focus, so every
   * collapsed group with an error opens within the click.
   */
  const openGroupsWithErrors = () => {
    const collapsed = groups.groups.filter(
      group => groups.errorCount(group.id) > 0 && !groups.isOpen(group.id)
    );
    if (collapsed.length === 0) return;
    // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- the summary's click handler runs next and needs the group shown
    flushSync(() => collapsed.forEach(group => groups.open(group.id)));
  };

  const isChat = app.type === 'chat' || !app.type;
  const toolSearchEnabled = featureFlags.isEnabled('toolSearch', false);

  return (
    <FormValidationProvider errors={validationErrors}>
      <AppFormLanguageProvider value={primary.language}>
        <div className="app-form-editor space-y-4">
          <div onClickCapture={openGroupsWithErrors}>
            <AdminFormErrorSummary
              errors={validationErrors}
              labels={errorLabels}
              title={t('admin.apps.edit.fixErrors')}
            />
          </div>

          <EditorGroup id="basics" groups={groups}>
            <BasicInfoSection
              app={app}
              onChange={onChange}
              t={t}
              currentLanguage={currentLanguage}
              uiConfig={uiConfig}
              validationErrors={validationErrors}
            />

            {/* Link apps keep Basics plus their one configuration card. */}
            {app.type === 'iframe' && (
              <IframeConfigSection app={app} onChange={handleInputChange} t={t} />
            )}
            {app.type === 'redirect' && (
              <RedirectConfigSection app={app} onChange={handleInputChange} t={t} />
            )}
          </EditorGroup>

          {/* The groups below apply to chat apps only. */}
          {isChat && (
            <>
              <EditorGroup id="instructions" groups={groups}>
                <SystemInstructionsSection
                  app={app}
                  onChange={onChange}
                  t={t}
                  validationErrors={validationErrors}
                />
                <VariablesSection app={app} onChange={onChange} />
                <StarterPromptsSection app={app} onChange={onChange} />
              </EditorGroup>

              <EditorGroup id="model" groups={groups}>
                <ModelSection app={app} onChange={onChange} availableModels={availableModels} />
              </EditorGroup>

              <EditorGroup id="knowledge" groups={groups}>
                {/* Connected systems: web search, iAssistant, people directories and
                    every other installed integration, each in one place (#3061) */}
                <IntegrationsConfigSection
                  app={app}
                  onChange={onChange}
                  toolSearchEnabled={toolSearchEnabled}
                />

                {/* Tool use and approval (the tools themselves come from the integrations above) */}
                <ToolsConfigSection
                  toolChoice={app.toolChoice}
                  onToolChoiceChange={toolChoice => handleInputChange('toolChoice', toolChoice)}
                  toolApproval={app.toolApproval}
                  onToolApprovalChange={toolApproval =>
                    handleInputChange('toolApproval', toolApproval)
                  }
                  {...(toolSearchEnabled
                    ? {
                        toolSearch: app.toolSearch,
                        onToolSearchChange: toolSearch =>
                          handleInputChange('toolSearch', toolSearch)
                      }
                    : {})}
                />

                {featureFlags.isEnabled('workflows', true) && (
                  <WorkflowsConfigSection
                    selectedWorkflows={app.workflows || []}
                    onWorkflowsChange={workflows => handleInputChange('workflows', workflows)}
                  />
                )}

                {/* Apps as tools */}
                {featureFlags.isEnabled('appAsTool', false) && (
                  <AppsConfigSection
                    appId={app.id}
                    selectedApps={app.apps || []}
                    onAppsChange={apps => handleInputChange('apps', apps)}
                  />
                )}

                {featureFlags.isEnabled('skills', false) && (
                  <SkillsConfigSection
                    enabled={app.skillSettings?.enabled === true}
                    allowPersonal={app.skillSettings?.allowPersonal !== false}
                    selectedSkills={app.skills || []}
                    onEnabledChange={enabled =>
                      handleInputChange('skillSettings', { ...app.skillSettings, enabled })
                    }
                    onAllowPersonalChange={allowPersonal =>
                      handleInputChange('skillSettings', { ...app.skillSettings, allowPersonal })
                    }
                    onSkillsChange={skills => handleInputChange('skills', skills)}
                  />
                )}

                {/* Linked projects - only while the projects feature is enabled */}
                {isProjectsEnabled && <ProjectsConfigSection app={app} onChange={onChange} t={t} />}
              </EditorGroup>

              <EditorGroup id="chat" groups={groups}>
                <UploadConfigSection
                  app={app}
                  onChange={handleInputChange}
                  t={t}
                  parseNumberOrUndefined={parseNumberOrUndefined}
                />
                <MagicPromptSection
                  app={app}
                  onChange={onChange}
                  availableModels={availableModels}
                />
                <ExportConfigSection app={app} onChange={onChange} />
                {/* Document template (generated PDF, Word, PowerPoint files) */}
                <DocumentTemplateSection app={app} onChange={onChange} />
                <CompareModeSection app={app} onChange={onChange} />
                <FeedbackSection app={app} onChange={onChange} />
                {/* First-turn AI notice (EU AI Act Art. 50(1)) */}
                <AiNoticeSection app={app} onChange={onChange} />
                <UsageGuideSection app={app} onChange={onChange} />
                <ChatBehaviourSection app={app} onChange={onChange} />
              </EditorGroup>

              <EditorGroup id="input" groups={groups}>
                <InputModeSection
                  app={app}
                  onChange={onChange}
                  t={t}
                  transcriptionModels={transcriptionModels}
                  ttsModels={ttsModels}
                  currentLanguage={currentLanguage}
                />
              </EditorGroup>

              <EditorGroup id="userSettings" groups={groups}>
                <SettingsConfigSection app={app} onChange={onChange} t={t} />
              </EditorGroup>
            </>
          )}
        </div>
      </AppFormLanguageProvider>
    </FormValidationProvider>
  );
}

export default AppFormEditor;
