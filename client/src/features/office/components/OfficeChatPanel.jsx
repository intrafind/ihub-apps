import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import ChatMessageList from '../../chat/components/ChatMessageList';
import ChatInput from '../../chat/components/ChatInput';
import ChatHeader from './chat/ChatHeader';
import OfficeContextStrip from './chat/OfficeContextStrip';
import ItemSelectorDialog from './apps-dialog';
import VariablesDialog, {
  buildInitialVariablesMap,
  getValidVariableDefinitions,
  mergeStarterPromptVariablesIntoValues,
  missingRequiredVariableNames
} from './variables-dialog';
import SettingsDialog from './settings-dialog';
import useOfficeChatAdapter from '../hooks/useOfficeChatAdapter';
import useOutlookMailContextSnapshot from '../hooks/useOutlookMailContextSnapshot';
import useAppSettings from '../../../shared/hooks/useAppSettings';
import useFileUploadHandler from '../../../shared/hooks/useFileUploadHandler';
import {
  displayReplyFormWithAssistantResponse,
  displayNewEmailFormWithAssistantResponse
} from '../utilities/replyForm';
import {
  buildPromptTemplate,
  combineUserTextWithEmailContext,
  buildFileDataFromMailAttachments,
  collectAttachmentsForSend,
  formatFileDataAsPromptText
} from '../utilities/buildChatApiMessages';
import {
  fetchCurrentMailContext,
  fetchSelectedItemsContext
} from '../utilities/outlookMailContext';
import {
  isMultiSelectBodySupported,
  isOutlookAppointmentMode
} from '../utilities/officeCapabilities';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { officeLocale } from '../utilities/officeLocale';
import { fetchApps } from '../../../api';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';
import { useEmbeddedHost } from '../contexts/EmbeddedHostContext';
import './OfficeChatPanel.css';

function buildParamsFromApp(app) {
  const params = { language: officeLocale };
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
  const embeddedHost = useEmbeddedHost();

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
  const mailSnapshot = useOutlookMailContextSnapshot();
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
  const [addEmailsLoading, setAddEmailsLoading] = useState(false);

  // Build the email-context text that will be appended to the outgoing message
  // so ChatInput can include it in the live token-count estimate. This mirrors
  // what combineUserTextWithEmailContext does at send time but with an empty
  // userText so we only get the email blocks (the typed text is already counted
  // separately by ChatInput).
  const emailContextText = useMemo(() => {
    const currentBodyText = mailSnapshot.includeBody ? mailSnapshot.ctx?.bodyText || '' : '';
    return combineUserTextWithEmailContext({
      userText: '',
      currentBodyText,
      currentItemId: mailSnapshot.ctx?.itemId,
      pinned: pinnedEmails
    });
  }, [mailSnapshot.includeBody, mailSnapshot.ctx, pinnedEmails]);

  // Attachment text for the live token estimate. The adapter extracts document
  // attachments (current email + pinned emails) into fileData at send time and
  // the server stitches their content into the prompt — so they must be counted
  // too, or the indicator wildly undercounts (a single document can dwarf the
  // email body). Mirrors the send path: same attachment merge, same extraction
  // pipeline, same [File: ...] block format the server prepends. Extraction is
  // async (JSZip/pdfjs/mammoth), so this lives in state guarded against stale
  // results; attachments only change on email navigation, pin/unpin, or
  // banner removals, so the cost stays off the keystroke path.
  const [attachmentContextText, setAttachmentContextText] = useState('');
  const attachmentsForEstimate = useMemo(() => {
    const removed = mailSnapshot.removedAttachmentIds;
    const current = (mailSnapshot.ctx?.attachments ?? []).filter(a => !removed?.has(a?.id));
    return collectAttachmentsForSend(current, pinnedEmails, mailSnapshot.ctx?.itemId ?? null);
  }, [mailSnapshot.ctx, mailSnapshot.removedAttachmentIds, pinnedEmails]);
  useEffect(() => {
    let stale = false;
    const extraction =
      attachmentsForEstimate.length === 0
        ? Promise.resolve(null)
        : buildFileDataFromMailAttachments(attachmentsForEstimate);
    extraction
      .then(files => {
        if (!stale) setAttachmentContextText(formatFileDataAsPromptText(files));
      })
      .catch(() => {
        if (!stale) setAttachmentContextText('');
      });
    return () => {
      stale = true;
    };
  }, [attachmentsForEstimate]);

  const estimateContextText = useMemo(
    () => [emailContextText, attachmentContextText].filter(Boolean).join('\n\n'),
    [emailContextText, attachmentContextText]
  );
  // itemId of the email currently open in Outlook. Lets us hide the
  // "Add this email" affordance once it's already in the pin list, and
  // dedupe in the prompt builder. Derived from the snapshot hook — the
  // single reader of the Outlook item on every ihub:itemchanged — instead
  // of a second parallel fetch, so the pin state can never disagree with
  // the banner about which email is open.
  const currentItemId = mailSnapshot.ctx?.itemId ?? null;
  // Whether the current Outlook item is a calendar appointment, used to
  // swap the starter-prompt set and hide the pin-email controls (which
  // don't apply to a single meeting). Comes from the snapshot's itemKind;
  // while the snapshot is (re)loading we fall back to a cheap synchronous
  // probe of the live item so users moving between Inbox and Calendar see
  // the right prompts without waiting for the fetch.
  const isAppointment = mailSnapshot.ctx
    ? mailSnapshot.ctx.itemKind === 'appointment'
    : isOutlookAppointmentMode();
  const multiSelectSupported = isMultiSelectBodySupported();
  // Incremented each time a message is sent (manual submit or starter prompt)
  // to trigger auto-collapse of the OfficeContextStrip, giving the user more
  // reading space for the assistant's response. The strip listens to changes
  // and collapses when this counter increments (see issue for attachments
  // auto-collapse).
  const [collapseStripCounter, setCollapseStripCounter] = useState(0);

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

  // Same for the adapter: useOfficeChatAdapter returns a fresh object every
  // render, so depending on it directly would re-run the listener effect on
  // every keystroke and streaming chunk. The previous version did exactly
  // that AND ran a full mail fetch (including attachment downloads) per
  // render, saturating the Office item API and widening the stale-snapshot
  // race — the snapshot hook is the single item reader now.
  const adapterRef = useRef(adapter);
  useEffect(() => {
    adapterRef.current = adapter;
  });

  useEffect(() => {
    const handler = () => {
      // Pinned emails are the whole point of the feature, so they must
      // survive ItemChanged. We only reset the chat history (and the
      // staged input) when the user has nothing pinned — otherwise we'd
      // silently throw away the context they were assembling.
      if (pinnedEmailsRef.current.length === 0) {
        chatIdRef.current = `office-${uuidv4()}`;
        selectedStarterPromptRef.current = null;
        adapterRef.current.clearMessages();
        setInputValue('');
      }
    };
    document.addEventListener('ihub:itemchanged', handler);
    return () => {
      document.removeEventListener('ihub:itemchanged', handler);
    };
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

  // Single "Add email(s)" entry point (issue #1553). Attaches every email
  // the user has Ctrl-selected in Outlook (Mailbox 1.15+) AND/OR the email
  // currently open in the reading pane. Replaces the old split
  // "Add this email" / "Add selected emails" buttons which (a) confused
  // users by always showing both and (b) silently no-op'd when the
  // multi-select reader returned nothing.
  const handleAddEmails = useCallback(async () => {
    setAddEmailsLoading(true);
    try {
      const collected = [];
      const seenIds = new Set();
      const pushEntry = entry => {
        if (entry.itemId && seenIds.has(entry.itemId)) return;
        if (entry.itemId) seenIds.add(entry.itemId);
        collected.push(entry);
      };

      // 1. Pull every email the user has multi-selected in Outlook. On a
      //    single selection this returns just the open email; on no
      //    selection it returns nothing — both handled by the fallback
      //    below. Errors are logged, not swallowed, so a failing host API
      //    no longer leaves the user staring at an unresponsive button.
      if (multiSelectSupported) {
        try {
          const items = await fetchSelectedItemsContext();
          if (Array.isArray(items)) {
            for (const it of items) {
              pushEntry({
                itemId: it.itemId ?? null,
                subject: it.subject ?? null,
                bodyText: it.bodyText ?? null,
                attachments: []
              });
            }
          }
        } catch (err) {
          console.warn('[office] reading selected emails failed', err);
        }
      }

      // 2. When the user has a single email open — either because
      //    multi-select isn't supported, or only one message is selected —
      //    pull the full current-mail context. This guarantees the open
      //    email is always added (the core fix for "nothing happened") and
      //    captures its attachments, which the lightweight multi-select
      //    reader deliberately skips.
      if (collected.length <= 1) {
        try {
          const ctx = await fetchCurrentMailContext();
          if (ctx?.available && (ctx.itemId || ctx.subject || ctx.bodyText)) {
            const entry = {
              itemId: ctx.itemId ?? null,
              subject: ctx.subject ?? null,
              bodyText: ctx.bodyText ?? null,
              attachments: ctx.attachments ?? []
            };
            // Upgrade the matching multi-select stub with attachments rather
            // than adding a duplicate of the same email.
            const idx = ctx.itemId ? collected.findIndex(c => c.itemId === ctx.itemId) : -1;
            if (idx >= 0) collected[idx] = entry;
            else pushEntry(entry);
          }
        } catch (err) {
          console.warn('[office] reading current email failed', err);
        }
      }

      if (collected.length === 0) return;

      setPinnedEmails(prev => {
        const seen = new Set(prev.map(p => p.itemId).filter(Boolean));
        const additions = collected.filter(c => !(c.itemId && seen.has(c.itemId)));
        return additions.length ? [...prev, ...additions] : prev;
      });
    } finally {
      setAddEmailsLoading(false);
    }
  }, [multiSelectSupported]);

  const handleInsert = useCallback(content => {
    displayReplyFormWithAssistantResponse(content);
  }, []);

  const handleInsertNew = useCallback(content => {
    displayNewEmailFormWithAssistantResponse(content);
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
      // Per-message host-context opt-out flags from the `+` menu, e.g.
      // { pageText: false } in the browser extension. The Outlook
      // taskpane no longer uses this for body / attachments — those
      // controls live on OfficeContextStrip and are forwarded via
      // params.hostContextOverride (mailSnapshot.buildSnapshotOverride).
      // See issue #1467.
      params.hostContextFlags = hostContextFlags;
      // Emails the user has explicitly attached to this chat — pin/collect
      // mode or bulk-pulled via native multi-select. Stripped from the
      // outgoing server payload inside useOfficeChatAdapter once their
      // bodies have been merged into apiMessage.content.
      params.pinnedEmails = pinnedEmails;

      // Mail context snapshot — the user can drop individual attachments
      // and toggle the body off via OfficeContextStrip / its embedded
      // OfficeMailContextBanner before send. Forwarding the edited
      // snapshot here avoids a second host.readMessageContext() round-trip
      // inside the adapter and ensures the user's removals (and body
      // opt-out) are honored. Null falls back to the adapter's own fetch
      // (extension side panel, no-context routes).
      const snapshotOverride = mailSnapshot.buildSnapshotOverride();
      if (snapshotOverride) params.hostContextOverride = snapshotOverride;

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
      // Trigger auto-collapse of the OfficeContextStrip so the user has more
      // reading space for the assistant's response.
      setCollapseStripCounter(prev => prev + 1);
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
      fileUploadHandler,
      mailSnapshot
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

  // Calendar items get their own starter-prompt set so users don't see
  // mail prompts like "Summarize this email" inside a meeting. Falls back
  // to the mail prompts when the admin hasn't configured calendar prompts
  // yet so an upgrade with no admin action still shows _something_.
  const configuredDefaults = Array.isArray(
    isAppointment ? officeConfig?.calendarStarterPrompts : officeConfig?.starterPrompts
  )
    ? isAppointment
      ? officeConfig.calendarStarterPrompts
      : officeConfig.starterPrompts
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
                onInsertNew={handleInsertNew}
                insertAction={embeddedHost?.insertAction}
                appId={selectedApp?.id}
                chatId={chatIdRef.current}
                app={selectedApp}
                showAvatars={false}
              />
            </div>

            {/* Collapsible context strip: hosts the email-body banner +
                the pinned-emails toolbar behind a single chevron so the
                chat input stays accessible on small Outlook task panes.
                See issue #1467. Renders nothing when there's no mail
                context (extension side panel, compose mode, etc.). */}
            <OfficeContextStrip
              ctx={mailSnapshot.ctx}
              loading={mailSnapshot.loading}
              visibleAttachments={mailSnapshot.visibleAttachments}
              removedAttachmentIds={mailSnapshot.removedAttachmentIds}
              onRemoveAttachment={mailSnapshot.removeAttachment}
              onRestoreAttachments={mailSnapshot.restoreAttachments}
              includeBody={mailSnapshot.includeBody}
              onToggleBody={mailSnapshot.setIncludeBody}
              pinned={pinnedEmails}
              onUnpin={handleUnpin}
              onClearPinned={handleClearPinned}
              onAddEmails={handleAddEmails}
              canAddEmails={!isAppointment && (!!currentItemId || multiSelectSupported)}
              addEmailsLoading={addEmailsLoading}
              // When multi-select isn't available we can reliably tell the
              // single open email is already attached, so we disable the
              // button and show "Already added". With multi-select the user
              // may still want to pull other selected emails, so it stays
              // enabled and the prompt builder dedupes by itemId.
              addEmailsDisabled={
                !multiSelectSupported &&
                !!currentItemId &&
                pinnedEmails.some(p => p.itemId === currentItemId)
              }
              collapseOnMessageSent={collapseStripCounter}
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
                // Include email body, pinned emails AND extracted attachment
                // content in the live token estimate so the context-window
                // indicator accounts for what will actually be sent to the LLM.
                extraContextText={estimateContextText}
                // Keep the input from dominating the small Outlook task pane;
                // long prompts scroll inside the 3-line box. Issue #1467.
                maxRows={3}
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
