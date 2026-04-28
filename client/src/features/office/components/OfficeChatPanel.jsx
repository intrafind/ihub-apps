import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import ChatMessageList from '../../chat/components/ChatMessageList';
import ChatInput from '../../chat/components/ChatInput';
import ChatHeader from './chat/ChatHeader';
import ItemSelectorDialog from './apps-dialog';
import VariablesDialog, {
  buildInitialVariablesMap,
  getValidVariableDefinitions,
  mergeStarterPromptVariablesIntoValues,
  missingRequiredVariableNames
} from './variables-dialog';
import SettingsDialog from './settings-dialog';
import useOfficeChatAdapter from '../hooks/useOfficeChatAdapter';
import useAppSettings from '../../../shared/hooks/useAppSettings';
import useFileUploadHandler from '../../../shared/hooks/useFileUploadHandler';
import { displayReplyFormWithAssistantResponse } from '../utilities/replyForm';
import { buildPromptTemplate } from '../utilities/buildChatApiMessages';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { officeLocale } from '../utilities/officeLocale';
import { fetchApps } from '../../../api/api';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';

function buildParamsFromApp(app) {
  const params = { language: officeLocale };
  if (app?.tokenLimit != null && !Number.isNaN(Number(app.tokenLimit))) {
    params.tokenLimit = Number(app.tokenLimit);
  }
  if (app?.preferredOutputFormat) params.outputFormat = String(app.preferredOutputFormat);
  if (app?.preferredStyle) params.style = String(app.preferredStyle);
  if (typeof app?.preferredTemperature === 'number' && !Number.isNaN(app.preferredTemperature)) {
    params.temperature = app.preferredTemperature;
  }
  return params;
}

function OfficeChatPanel({ authData, selectedApp, setSelectedApp, onLogout }) {
  const navigate = useNavigate();
  const officeConfig = useOfficeConfig();

  const appName = getLocalizedContent(selectedApp?.name, officeLocale);
  const greetingTitle = getLocalizedContent(selectedApp?.greeting?.title, officeLocale);
  const greetingSubtitle = getLocalizedContent(selectedApp?.greeting?.subtitle, officeLocale);

  // Chat ID: use a stable ref, reset on item change or new chat
  const chatIdRef = useRef(`office-${uuidv4()}`);
  const selectedStarterPromptRef = useRef(null);

  const adapter = useOfficeChatAdapter({
    appId: selectedApp?.id,
    chatId: chatIdRef.current
  });

  const {
    models,
    selectedModel,
    setSelectedModel,
    enabledTools,
    setEnabledTools,
    websearchEnabled,
    setWebsearchEnabled
  } = useAppSettings(selectedApp?.id, selectedApp);
  const fileUploadHandler = useFileUploadHandler();
  const currentModel = models.find(m => m.id === selectedModel) || null;
  const uploadConfig = fileUploadHandler.createUploadConfig(selectedApp, currentModel);

  const [inputValue, setInputValue] = useState('');
  const [appPromptVariables, setAppPromptVariables] = useState({});
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [isVariablesOpen, setIsVariablesOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectorItems, setSelectorItems] = useState([]);

  // Initialize variables when app changes
  useEffect(() => {
    if (!selectedApp?.id) {
      setAppPromptVariables({});
      setIsVariablesOpen(false);
      return;
    }
    const initial = buildInitialVariablesMap(selectedApp.variables);
    setAppPromptVariables(initial);
    const defs = getValidVariableDefinitions(selectedApp.variables);
    const missingRequired = defs.some(
      d => d.required === true && !String(initial[d.name] ?? '').trim()
    );
    setIsVariablesOpen(missingRequired);
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [selectedApp?.id]);

  // Reset chat when Outlook switches emails
  useEffect(() => {
    const handler = () => {
      chatIdRef.current = `office-${uuidv4()}`;
      selectedStarterPromptRef.current = null;
      adapter.clearMessages();
      setInputValue('');
    };
    document.addEventListener('ihub:itemchanged', handler);
    return () => document.removeEventListener('ihub:itemchanged', handler);
  }, [adapter]);

  const handleInsert = useCallback(content => {
    displayReplyFormWithAssistantResponse(content);
  }, []);

  const submitMessage = useCallback(
    (messageText, overrides = {}) => {
      const text = (messageText ?? '').trim();
      if (!text && !selectedApp?.allowEmptyContent) return;

      const promptTemplate = buildPromptTemplate(selectedStarterPromptRef.current, selectedApp);
      const params = buildParamsFromApp(selectedApp);
      if (selectedModel) params.modelId = selectedModel;
      if (enabledTools?.length) params.enabledTools = enabledTools;
      if (selectedApp?.websearch?.enabled) params.websearchEnabled = websearchEnabled;

      // Resend can pass a `selectedFile` override to bypass async state updates;
      // otherwise we read whatever the user has staged in the uploader.
      const sf =
        'selectedFile' in overrides ? overrides.selectedFile : fileUploadHandler.selectedFile;
      const imageData = sf?.type === 'image' ? sf : null;
      const fileData = sf?.type === 'file' ? sf : null;

      adapter.sendMessage({
        displayMessage: { content: text },
        apiMessage: {
          content: text,
          promptTemplate,
          variables: appPromptVariables,
          imageData,
          fileData
        },
        params,
        sendChatHistory: selectedApp?.sendChatHistory !== false
      });

      setInputValue('');
      selectedStarterPromptRef.current = null;
      fileUploadHandler.clearSelectedFile();
    },
    [
      selectedApp,
      appPromptVariables,
      adapter,
      selectedModel,
      enabledTools,
      websearchEnabled,
      fileUploadHandler
    ]
  );

  const handleSubmit = useCallback(
    e => {
      e?.preventDefault?.();
      submitMessage(inputValue);
    },
    [submitMessage, inputValue]
  );

  // Resend a previous message in the Outlook taskpane.
  // adapter.resendMessage truncates the conversation at the original message
  // and returns the content/files to re-run. The stored imageData/fileData is
  // a *combined* array of manual uploads + email attachments (see #1326). We
  // must only re-attach the manual uploads here — the email attachments will
  // be re-pulled fresh by useOfficeChatAdapter so the user still sees the
  // current message context, not a stale one. Manual uploads carry a
  // `type: 'image' | 'file'` field; email attachments do not.
  const pickManualUpload = data => {
    if (!data) return null;
    const arr = Array.isArray(data) ? data : [data];
    const manuals = arr.filter(d => d && (d.type === 'image' || d.type === 'file'));
    return manuals.length > 0 ? manuals[0] : null;
  };

  const handleResend = useCallback(
    (messageId, editedContent) => {
      const { content, imageData, fileData } = adapter.resendMessage(messageId, editedContent);
      const manualUpload = pickManualUpload(imageData) || pickManualUpload(fileData);

      if (!content && !manualUpload && !selectedApp?.allowEmptyContent) return;

      // Mirror the manual upload back into the uploader UI so the user sees
      // the file pill before submit, then send with an explicit override so
      // submitMessage doesn't depend on the async state update.
      fileUploadHandler.clearSelectedFile();
      if (manualUpload) {
        fileUploadHandler.setSelectedFile(manualUpload);
      }
      submitMessage(content || '', { selectedFile: manualUpload });
    },
    [adapter, selectedApp?.allowEmptyContent, submitMessage, fileUploadHandler]
  );

  const handlePromptSelect = useCallback(
    prompt => {
      if (prompt.raw != null) {
        selectedStarterPromptRef.current = prompt.raw;
      } else {
        selectedStarterPromptRef.current = { system: selectedApp?.system };
      }
      const pv = prompt.raw?.variables;
      if (pv && typeof pv === 'object' && selectedApp?.variables?.length) {
        setAppPromptVariables(prev =>
          mergeStarterPromptVariablesIntoValues(selectedApp.variables, pv, prev)
        );
      }

      // If the selected prompt supports autoSend (or it's a default Outlook prompt which
      // always auto-sends), fire it directly without requiring the user to press send.
      if (prompt.autoSend) {
        setInputValue(prompt.message);
        submitMessage(prompt.message);
      } else {
        setInputValue(prompt.message);
      }
    },
    [selectedApp, submitMessage]
  );

  const handleOpenSelector = useCallback(() => {
    fetchApps()
      .then(data => {
        if (Array.isArray(data)) setSelectorItems(data);
        setIsSelectorOpen(true);
      })
      .catch(() => setIsSelectorOpen(true));
  }, []);

  const handleSelectApp = useCallback(
    newApp => {
      chatIdRef.current = `office-${uuidv4()}`;
      selectedStarterPromptRef.current = null;
      adapter.clearMessages();
      setInputValue('');
      setSelectedApp(newApp);
      setIsSelectorOpen(false);
    },
    [adapter, setSelectedApp]
  );

  const handleNewChat = useCallback(() => {
    chatIdRef.current = `office-${uuidv4()}`;
    selectedStarterPromptRef.current = null;
    adapter.clearMessages();
    setInputValue('');
  }, [adapter]);

  if (!authData) return null;
  if (!selectedApp) return <Navigate to="/select" replace />;

  const configuredDefaults = Array.isArray(officeConfig?.starterPrompts)
    ? officeConfig.starterPrompts
    : [];

  const defaultPrompts = configuredDefaults.map((p, idx) => ({
    key: `office-${idx}`,
    label: getLocalizedContent(p?.title, officeLocale),
    message: getLocalizedContent(p?.message, officeLocale),
    // Default Outlook prompts should fire directly on click per product requirements.
    autoSend: true
  }));

  const starterPrompts = selectedApp?.starterPrompts?.length
    ? selectedApp.starterPrompts.map((p, idx) => ({
        key: p?.id ?? `${idx}`,
        label: getLocalizedContent(p?.title, officeLocale),
        subtitle: getLocalizedContent(p?.description, officeLocale),
        message: getLocalizedContent(p?.message, officeLocale),
        autoSend: p?.autoSend === true,
        raw: p
      }))
    : defaultPrompts;

  const menuItems = [
    ...(getValidVariableDefinitions(selectedApp?.variables).length > 0
      ? [{ key: 'variables', label: 'Show variables', onClick: () => setIsVariablesOpen(true) }]
      : []),
    { key: 'settings', label: 'Settings', onClick: () => setIsSettingsOpen(true) },
    { key: 'logout', label: 'Logout', onClick: onLogout }
  ];

  const hasMessages = adapter.messages.length > 0;

  return (
    <div className="h-screen w-full flex flex-col p-0 bg-slate-50">
      <div className="flex-1 min-h-0 flex flex-col max-w-lg mx-auto w-full">
        <div className="flex flex-col h-full min-h-0 w-full overflow-hidden border border-[#e0e0e0] rounded-lg bg-white">
          <ChatHeader
            showCheckmark={false}
            selectedApp={{ name: appName || 'Select app' }}
            onItemClick={handleOpenSelector}
            onWriteClick={handleNewChat}
            onBackClick={() => navigate('/select', { replace: true })}
            menuItems={menuItems}
          />

          <div className="flex-1 flex flex-col min-h-0">
            {/* Empty state: greeting + starter prompts */}
            {!hasMessages && (
              <div className="px-4 pt-6 pb-3 border-b border-slate-100 bg-slate-50/60">
                <div className="flex flex-col items-center mb-4 text-center">
                  {greetingTitle || greetingSubtitle ? (
                    <>
                      {greetingTitle && (
                        <p className="text-base font-semibold text-slate-900">{greetingTitle}</p>
                      )}
                      {greetingSubtitle && (
                        <p className="mt-1 text-sm text-slate-600">{greetingSubtitle}</p>
                      )}
                    </>
                  ) : (
                    <div
                      className="w-16 h-16 flex items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 text-white font-bold text-2xl shadow-lg"
                      aria-hidden
                    >
                      AI
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {starterPrompts.map(prompt => (
                    <button
                      key={prompt.key}
                      type="button"
                      onClick={() => handlePromptSelect(prompt)}
                      className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 transition-colors text-sm text-slate-700"
                    >
                      {prompt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <ChatMessageList
                messages={adapter.messages}
                outputFormat={selectedApp?.preferredOutputFormat || 'markdown'}
                onDelete={adapter.deleteMessage}
                onEdit={adapter.editMessage}
                onResend={handleResend}
                editable={true}
                compact={true}
                onInsert={handleInsert}
                appId={selectedApp?.id}
                chatId={chatIdRef.current}
                app={selectedApp}
                showAvatars={false}
              />
            </div>

            {/* Input */}
            <div className="border-t border-gray-200 bg-white flex-shrink-0">
              <ChatInput
                app={selectedApp}
                value={inputValue}
                onChange={e => setInputValue(e?.target?.value ?? e)}
                onSubmit={handleSubmit}
                isProcessing={adapter.processing}
                onCancel={adapter.cancelGeneration}
                allowEmptySubmit={!!selectedApp?.allowEmptyContent}
                currentLanguage={officeLocale}
                showModelSelector={
                  selectedApp?.disallowModelSelection !== true &&
                  selectedApp?.settings?.model?.enabled !== false
                }
                models={models}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                uploadConfig={uploadConfig}
                onFileSelect={fileUploadHandler.handleFileSelect}
                selectedFile={fileUploadHandler.selectedFile}
                showUploader={fileUploadHandler.showUploader}
                onToggleUploader={fileUploadHandler.toggleUploader}
                enabledTools={selectedApp?.tools?.length ? enabledTools : null}
                onEnabledToolsChange={selectedApp?.tools?.length ? setEnabledTools : null}
                websearchEnabled={websearchEnabled}
                onWebsearchEnabledChange={
                  selectedApp?.websearch?.enabled ? setWebsearchEnabled : null
                }
                clarificationPending={adapter.clarificationPending}
              />
            </div>
          </div>
        </div>
      </div>

      <ItemSelectorDialog
        items={selectorItems}
        selectedApp={selectedApp}
        isOpen={isSelectorOpen}
        onSelect={handleSelectApp}
        onClose={() => setIsSelectorOpen(false)}
      />
      <VariablesDialog
        variables={selectedApp?.variables}
        currentValues={appPromptVariables}
        closeRequiresRequiredComplete
        isOpen={isVariablesOpen}
        onClose={() => setIsVariablesOpen(false)}
        onCancel={() => {
          setIsVariablesOpen(false);
          const defs = getValidVariableDefinitions(selectedApp?.variables);
          const missing = missingRequiredVariableNames(defs, appPromptVariables);
          if (missing.length > 0) navigate('/select', { replace: true });
        }}
        onSave={setAppPromptVariables}
      />
      <SettingsDialog
        user={authData?.user}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}

export default OfficeChatPanel;
