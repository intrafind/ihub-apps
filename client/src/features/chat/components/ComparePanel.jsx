import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import useAppChat from '../hooks/useAppChat';
import ChatMessageList from './ChatMessageList';
import ModelSelector from './ModelSelector';

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
    onDocumentAction
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
    // (which is keyed by appId) would race between the panels. Keep these chats ephemeral.
    persistConversationId: false
  });

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
          params: { ...(messageStructure.params || {}), modelId: m }
        });
      },
      clear() {
        const { chat: c } = latestRef.current;
        c.cancelGeneration();
        c.clearMessages();
        c.resetConversationState();
        setChatId(`compare-${uuidv4()}`);
      },
      cancel() {
        latestRef.current.chat.cancelGeneration();
      }
    }),
    []
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
        promptTemplate: app?.prompt || null,
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
      <div className="flex-shrink-0 mb-3 pb-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full flex-shrink-0 ${accentColorClass}`} />
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex-shrink-0">
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
      <div className="flex-1 min-h-0 flex flex-col">
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
          onDocumentAction={onDocumentAction}
          compact={true}
        />
      </div>
    </div>
  );
});

export default ComparePanel;
