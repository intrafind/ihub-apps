// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import useAppChat from '../hooks/useAppChat';
import { deleteChat } from '../../../api';
import ChatMessageList from './ChatMessageList';
import ModelSelector from './ModelSelector';
import { isStartFormEnabled } from '../utils/startForm';

/**
 * Self-contained chat panel used in compare mode.
 *
 * Each panel owns:
 *   - its own model selection
 *   - its own useAppChat instance (with a unique chatId)
 *   - its own delete / edit / resend handlers
 *
 * The parent controls the panel through a ref (imperative handle):
 *   - sendMessage(messageStructure) — sends with this panel's model
 *   - clear()                       — clears messages and regenerates the chatId
 *   - cancel()                      — cancels in-flight generation
 *
 * `hideTranscript` leaves only the header with the model picker: the view
 * shows its start form instead.
 *
 * The parent is notified of processing state via the onProcessingChange callback.
 */
const ComparePanel = forwardRef(function ComparePanel(
  {
    label,
    accentColorClass = 'bg-blue-500',
    app,
    appId,
    models,
    defaultModelId,
    currentLanguage,
    outputFormat,
    sendChatHistory,
    onProcessingChange,
    onMessageComplete,
    onOpenInCanvas,
    canvasEnabled,
    requiredIntegrations,
    onConnectIntegration,
    onClarificationSubmit,
    onClarificationSkip,
    onOpenSourceInApp,
    linkPath,
    hideTranscript = false
  },
  ref
) {
  const [selectedModel, setSelectedModel] = useState(defaultModelId);

  // Unique chatId per panel, regenerated on clear() so each comparison starts fresh.
  const [chatId, setChatId] = useState(() => `compare-${uuidv4()}`);

  const chat = useAppChat({
    appId,
    chatId,
    onMessageComplete,
    // Compare panels share the same appId; persisting the iAssistant conversationId
    // (which is keyed by appId) would race between the panels.
    persistConversationId: false,
    // A comparison fans one submit out to several chats, so none of them
    // belongs in the history: each panel's chat is a temporary one, and it is
    // always new — there is nothing stored to wait for.
    ephemeral: true,
    hydrates: false
  });

  // The panel's chat is stored but listed nowhere, so nothing can reopen it
  // once the panel lets go of it: delete it then rather than leave it to
  // expire. A chat that never got a message was never stored.
  const storedChatIdRef = useRef(null);
  storedChatIdRef.current = chat.messages.some(message => message.role === 'user') ? chatId : null;
  const forgetChat = useCallback(() => {
    const stored = storedChatIdRef.current;
    if (stored) deleteChat(stored).catch(() => {});
  }, []);
  useEffect(() => forgetChat, [forgetChat]);

  // Keep selectedModel in sync if the available models change (e.g. defaults arrive late).
  useEffect(() => {
    if (!selectedModel && defaultModelId) {
      setSelectedModel(defaultModelId);
    }
  }, [defaultModelId, selectedModel]);

  // Notify parent about processing state so it can disable the input / show spinners.
  useEffect(() => {
    onProcessingChange?.(chat.processing);
  }, [chat.processing, onProcessingChange]);

  // Stash latest values in a ref so the imperative handle stays stable across renders.
  const latestRef = useRef({ chat, selectedModel });
  latestRef.current = { chat, selectedModel };

  useImperativeHandle(
    ref,
    () => ({
      sendMessage(messageStructure) {
        const { chat: c, selectedModel: m } = latestRef.current;
        if (!m) return;
        c.sendMessage({
          ...messageStructure,
          params: { ...messageStructure.params, modelId: m }
        });
      },
      clear() {
        const { chat: c } = latestRef.current;
        c.cancelGeneration('compare');
        forgetChat();
        c.clearMessages();
        c.resetConversationState();
        setChatId(`compare-${uuidv4()}`);
      },
      cancel() {
        latestRef.current.chat.cancelGeneration('compare');
      }
    }),
    [forgetChat]
  );

  const handleResend = (messageId, editedContent) => {
    const data = chat.resendMessage(messageId, editedContent);
    if (
      !data.content &&
      !data.imageData &&
      !data.audioData &&
      !data.fileData &&
      !app?.allowEmptyContent
    ) {
      return;
    }

    chat.sendMessage({
      displayMessage: {
        content: data.content || '',
        meta: {
          rawContent: data.content || '',
          variables: data.variables || {}
        }
      },
      apiMessage: {
        content: data.content || '',
        // With a start form, the content already is the rendered prompt.
        promptTemplate: isStartFormEnabled(app) ? null : app?.prompt || null,
        variables: data.variables || {},
        imageData: data.imageData,
        audioData: data.audioData,
        fileData: data.fileData
      },
      params: { modelId: selectedModel },
      sendChatHistory,
      messageMetadata: {
        customResponseRenderer: app?.customResponseRenderer,
        outputFormat
      }
    });
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div
        className={`shrink-0 pb-3 ${hideTranscript ? '' : 'mb-3 border-b border-gray-200 dark:border-gray-700'}`}
      >
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full shrink-0 ${accentColorClass}`} />
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300 shrink-0">
            {label}
          </span>
          <ModelSelector
            app={app}
            models={models}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            currentLanguage={currentLanguage}
            dropdownDirection="down"
          />
        </div>
      </div>
      <div className={hideTranscript ? 'hidden' : 'flex-1 min-h-0 flex flex-col'}>
        <ChatMessageList
          messages={chat.messages}
          outputFormat={outputFormat}
          onDelete={chat.deleteMessage}
          onEdit={chat.editMessage}
          onResend={handleResend}
          editable={true}
          appId={appId}
          chatId={chatId}
          modelId={selectedModel}
          onOpenInCanvas={onOpenInCanvas}
          canvasEnabled={canvasEnabled}
          requiredIntegrations={requiredIntegrations}
          onConnectIntegration={onConnectIntegration}
          app={app}
          models={models}
          onClarificationSubmit={onClarificationSubmit}
          onClarificationSkip={onClarificationSkip}
          onOpenSourceInApp={onOpenSourceInApp}
          linkPath={linkPath}
          compact={true}
        />
      </div>
    </div>
  );
});

export default ComparePanel;
