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
import PinnedEmailsBar from './PinnedEmailsBar';
import useOfficeChatAdapter from '../hooks/useOfficeChatAdapter';
import useAppSettings from '../../../shared/hooks/useAppSettings';
import useFileUploadHandler from '../../../shared/hooks/useFileUploadHandler';
import { displayReplyFormWithAssistantResponse } from '../utilities/replyForm';
import { buildPromptTemplate } from '../utilities/buildChatApiMessages';
import {
  fetchCurrentMailContext,
  fetchSelectedItemsContext
} from '../utilities/outlookMailContext';
import { isMultiSelectBodySupported } from '../utilities/officeCapabilities';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { officeLocale } from '../utilities/officeLocale';
import { fetchApps } from '../../../api/api';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';
import './OfficeChatPanel.css';

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
    setWebsearchEnabled,
    hostContextFlags,
    setHostContextFlags
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
  // Emails the user has explicitly attached to this chat (pin/collect mode,
  // or bulk-pulled via Mailbox 1.15+ multi-select). Survives ItemChanged so
  // the user can navigate between emails while building up a context set;
  // wiped on new-chat / app-switch alongside the chat history.
  const [pinnedEmails, setPinnedEmails] = useState([]);
  const [multiSelectLoading, setMultiSelectLoading] = useState(false);
  // itemId of the email currently open in Outlook. Lets us hide the
  // "Add this email" affordance once it's already in the pin list, and
  // dedupe in the prompt builder.
  const [currentItemId, setCurrentItemId] = useState(null);
  const multiSelectSupported = isMultiSelectBodySupported();

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

  // Mirror of `pinnedEmails` for the ItemChanged listener — using a ref
  // avoids re-binding the document listener every time the array changes.
  const pinnedEmailsRef = useRef([]);
  useEffect(() => {
    pinnedEmailsRef.current = pinnedEmails;
  }, [pinnedEmails]);

  // Track the currently-open email's itemId so the "Add this email" button
  // can hide once the user has pinned it. Reading the id alone is cheap —
  // we don't fetch the body here, that still happens lazily inside
  // useOfficeChatAdapter.sendMessage. Refreshed on mount and whenever
  // Outlook switches emails.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const ctx = await fetchCurrentMailContext();
        if (!cancelled) setCurrentItemId(ctx?.itemId ?? null);
      } catch {
        if (!cancelled) setCurrentItemId(null);
      }
    };
    refresh();
    const handler = () => {
      refresh();
      // Pinned emails are the whole point of the feature, so they must
      // survive ItemChanged. We only reset the chat history (and the
      // staged input) when the user has nothing pinned — otherwise we'd
      // silently throw away the context they were assembling.
      if (pinnedEmailsRef.current.length === 0) {
        chatIdRef.current = `office-${uuidv4()}`;
        selectedStarterPromptRef.current = null;
        adapter.clearMessages();
        setInputValue('');
      }
    };
    document.addEventListener('ihub:itemchanged', handler);
    return () => {
      cancelled = true;
      document.removeEventListener('ihub:itemchanged', handler);
    };
  }, [adapter]);

  const handlePinCurrent = useCallback(async () => {
    try {
      const ctx = await fetchCurrentMailContext();
      if (!ctx?.available) return;
      if (!ctx.itemId && !ctx.subject && !ctx.bodyText) return;
      setPinnedEmails(prev => {
        if (ctx.itemId && prev.some(p => p.itemId === ctx.itemId)) return prev;
        return [
          ...prev,
          {
            itemId: ctx.itemId ?? null,
            subject: ctx.subject ?? null,
            bodyText: ctx.bodyText ?? null,
            attachments: ctx.attachments ?? []
          }
        ];
      });
    } catch {
      /* silently swallow — surfacing host errors here would be noisy */
    }
  }, []);

  const handleUnpin = useCallback(itemId => {
    setPinnedEmails(prev => {
      if (!itemId) return prev;
      return prev.filter(p => p.itemId !== itemId);
    });
  }, []);

  const handleClearPinned = useCallback(() => {
    setPinnedEmails([]);
  }, []);

  const handlePinSelected = useCallback(async () => {
    if (!multiSelectSupported) return;
    setMultiSelectLoading(true);
    try {
      const items = await fetchSelectedItemsContext();
      if (!Array.isArray(items) || items.length === 0) return;
      setPinnedEmails(prev => {
        const seen = new Set(prev.map(p => p.itemId).filter(Boolean));
        const additions = [];
        for (const it of items) {
          if (it.itemId && seen.has(it.itemId)) continue;
          if (it.itemId) seen.add(it.itemId);
          additions.push({
            itemId: it.itemId ?? null,
            subject: it.subject ?? null,
            bodyText: it.bodyText ?? null,
            attachments: []
          });
        }
        return additions.length ? [...prev, ...additions] : prev;
      });
    } catch {
      /* silently swallow */
    } finally {
      setMultiSelectLoading(false);
    }
  }, [multiSelectSupported]);

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
      // Per-message host-context opt-out flags, e.g. { emailBody: false }.
      // useOfficeChatAdapter consults these (alongside the host adapter's
      // contextToggles declarations) to strip body / attachments from the
      // outgoing apiMessage. Empty object in the main web app — no-op.
      params.hostContextFlags = hostContextFlags;
      // Emails the user has explicitly attached to this chat — pin/collect
      // mode or bulk-pulled via native multi-select. Stripped from the
      // outgoing server payload inside useOfficeChatAdapter once their
      // bodies have been merged into apiMessage.content.
      params.pinnedEmails = pinnedEmails;

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
      hostContextFlags,
      pinnedEmails,
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
      setPinnedEmails([]);
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
    setPinnedEmails([]);
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
    <div className="office-task-pane h-screen w-full flex flex-col p-0 bg-slate-50">
      <div className="flex-1 min-h-0 flex flex-col w-full">
        <div className="flex flex-col h-full min-h-0 w-full overflow-hidden bg-white">
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
              <div className="office-greeting border-b border-slate-100 bg-slate-50/60">
                <div className="flex flex-col items-center office-greeting-header text-center">
                  {greetingTitle || greetingSubtitle ? (
                    <>
                      {greetingTitle && (
                        <p className="office-greeting-title font-semibold text-slate-900">
                          {greetingTitle}
                        </p>
                      )}
                      {greetingSubtitle && (
                        <p className="office-greeting-subtitle text-slate-600">
                          {greetingSubtitle}
                        </p>
                      )}
                    </>
                  ) : (
                    <div
                      className="office-greeting-badge flex items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 text-white font-bold shadow-lg"
                      aria-hidden
                    >
                      AI
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  {starterPrompts.map(prompt => (
                    <button
                      key={prompt.key}
                      type="button"
                      onClick={() => handlePromptSelect(prompt)}
                      className="office-starter-prompt w-full text-left rounded-lg border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 transition-colors text-slate-700"
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

            {/* Pinned emails toolbar (above input) */}
            <PinnedEmailsBar
              pinned={pinnedEmails}
              onUnpin={handleUnpin}
              onClearAll={handleClearPinned}
              onPinCurrent={handlePinCurrent}
              onPinSelected={handlePinSelected}
              canPinCurrent={!!currentItemId}
              isCurrentPinned={
                !!currentItemId && pinnedEmails.some(p => p.itemId === currentItemId)
              }
              isMultiSelectSupported={multiSelectSupported}
              multiSelectLoading={multiSelectLoading}
            />

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
                hostContextFlags={hostContextFlags}
                onHostContextFlagChange={(key, value) =>
                  setHostContextFlags(prev => ({ ...(prev || {}), [key]: value }))
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
