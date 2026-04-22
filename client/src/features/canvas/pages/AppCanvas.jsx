import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// Import components
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import SharedAppHeader from '../../apps/components/SharedAppHeader';

// Import canvas-specific components
import CanvasChatPanel from '../components/CanvasChatPanel';
import CanvasEditor from '../components/CanvasEditor';
import FloatingToolbox from '../components/FloatingToolbox';
import CanvasContentConfirmationModal from '../components/CanvasContentConfirmationModal';
import AppShareModal from '../../apps/components/AppShareModal';

// Import hooks and utilities
import useAppChat from '../../chat/hooks/useAppChat';
import useVoiceCommands from '../../voice/hooks/useVoiceCommands';
import useAppSettings from '../../../shared/hooks/useAppSettings';
import useCanvas from '../hooks/useCanvas';
import VoiceFeedback from '../../voice/components/VoiceFeedback';
import useVoiceRecognition from '../../voice/hooks/useVoiceRecognition';
import { fetchAppDetails } from '../../../api/api';
import { markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';
import { getOrCreateChatId, resetChatId } from '../../../utils/chatId';

// Import AI-assisted canvas specific styles
import './AppCanvas.css';

export default function AppCanvas() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { appId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // App and loading states
  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Shared app settings hook
  const {
    selectedModel,
    selectedStyle,
    selectedOutputFormat,
    temperature,
    sendChatHistory,
    enabledTools,
    models,
    styles,
    setSelectedModel,
    setSelectedStyle,
    setSelectedOutputFormat,
    setTemperature,
    setSendChatHistory,
    setEnabledTools,
    modelsLoading
  } = useAppSettings(appId, app);

  // Apply settings from query parameters once data is loaded
  useEffect(() => {
    if (!app || modelsLoading) return;

    const newVars = {};
    let changed = false;

    const m = searchParams.get('model');
    if (m) {
      setSelectedModel(m);
      changed = true;
    }
    const st = searchParams.get('style');
    if (st) {
      setSelectedStyle(st);
      changed = true;
    }
    const out = searchParams.get('outfmt');
    if (out) {
      setSelectedOutputFormat(out);
      changed = true;
    }
    const tempParam = searchParams.get('temp');
    if (tempParam) {
      setTemperature(parseFloat(tempParam));
      changed = true;
    }
    const hist = searchParams.get('history');
    if (hist) {
      setSendChatHistory(hist === 'true');
      changed = true;
    }

    searchParams.forEach((value, key) => {
      if (key.startsWith('var_')) {
        newVars[key.slice(4)] = value;
        changed = true;
      }
    });

    if (changed) {
      const newSearch = new URLSearchParams(searchParams);
      [
        'model',
        'style',
        'outfmt',
        'temp',
        'history',
        ...Object.keys(newVars).map(v => `var_${v}`)
      ].forEach(k => newSearch.delete(k));
      navigate(`${window.location.pathname}?${newSearch.toString()}`, { replace: true });
    }
  }, [
    app,
    modelsLoading,
    navigate,
    searchParams,
    setSelectedModel,
    setSelectedOutputFormat,
    setSelectedStyle,
    setSendChatHistory,
    setTemperature
  ]);

  // Canvas editor states
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Chat states
  const [inputValue, setInputValue] = useState('');
  const [panelSizes, setPanelSizes] = useState({ chat: 35, canvas: 65 });
  const [isDragging, setIsDragging] = useState(false);

  // Configuration panel states
  const [showConfig, setShowConfig] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const shareEnabled = app?.features?.shortLinks !== false;

  // Content confirmation modal state
  const [showContentModal, setShowContentModal] = useState(false);
  const [contentModalData, setContentModalData] = useState(null);

  const quillRef = useRef(null);
  const chatId = useRef(getOrCreateChatId(appId, 'canvas'));

  useEffect(() => {
    chatId.current = getOrCreateChatId(appId, 'canvas');
  }, [appId]);
  const chatInputRef = useRef(null);

  // Initialize custom hooks
  // Chat message management
  const {
    messages,
    processing,
    sendMessage: sendChatMessage,
    resendMessage: prepareResend,
    deleteMessage,
    editMessage,
    clearMessages,
    cancelGeneration,
    addSystemMessage
  } = useAppChat({ appId, chatId: chatId.current });

  // Ref-based forwarder so useCanvas can call handlePromptSubmit without a circular dependency.
  // useCanvas needs handlePromptSubmit (for FloatingToolbox actions), but handlePromptSubmit needs
  // selectedText/editorContent from useCanvas — breaking the cycle with a ref avoids the TDZ.
  const handlePromptSubmitRef = useRef(null);
  const stableSubmitForwarder = useCallback(
    (...args) => handlePromptSubmitRef.current?.(...args),
    []
  );

  // Initialize unified canvas hook BEFORE handlePromptSubmit so selectedText/editorContent
  // are declared before handlePromptSubmit's dependency array is evaluated.
  const canvasHook = useCanvas(appId, null, { quillRef, chatInputRef }, stableSubmitForwarder);

  // Extract all canvas functionality from the unified hook
  const {
    // Content management
    content: editorContent,
    setContent: setEditorContent,
    setContentWithConfirmation,
    clearContent: clearCanvasContent,

    // Selection and editing state
    selection,
    selectedText,
    cursorPosition,
    setSelection,
    setSelectedText,

    // Editing functions
    handleSelectionChange,
    handleEditAction
  } = canvasHook;

  // Handle general prompt submission
  const handlePromptSubmit = useCallback(
    async (e, options = {}) => {
      // If called with a string as first parameter (for edit actions), treat it as inputText
      const inputText = typeof e === 'string' ? e : null;
      const textToSubmit = inputText || inputValue;

      // Only call preventDefault if e is actually an event object
      if (e && typeof e === 'object' && typeof e.preventDefault === 'function') {
        e.preventDefault();
      }

      if (!textToSubmit.trim()) return;

      // Prevent sending during active processing
      if (processing) {
        return;
      }

      // Clear the input field if using the input value (not for edit actions)
      if (!inputText) {
        setInputValue('');
      }

      // Add context about selected text and current document
      let contextualInput = textToSubmit;
      if (selectedText) {
        contextualInput += `\n\nSelected text: "${selectedText}"`;
      }
      if (editorContent.trim()) {
        const docText = editorContent.replace(/<[^>]*>/g, '').trim();
        // For autoApply apps, send the full document so the LLM can produce accurate replacements
        if (app?.features?.canvasAutoApply === true) {
          contextualInput += `\n\nCurrent document:\n${docText}`;
        } else {
          contextualInput += `\n\nCurrent document context: ${docText.substring(0, 500)}...`;
        }
      }

      try {
        sendChatMessage({
          displayMessage: {
            content: textToSubmit,
            meta: {
              rawContent: textToSubmit,
              selectedText: selectedText || null,
              hasDocumentContext: !!editorContent.trim(),
              ...options
            }
          },
          apiMessage: {
            content: contextualInput,
            ...options
          },
          params: {
            modelId: selectedModel,
            style: options?.bypassAppPrompts ? 'normal' : selectedStyle,
            temperature,
            outputFormat: selectedOutputFormat,
            language: currentLanguage,
            bypassAppPrompts: !!options?.editAction,
            ...(enabledTools && enabledTools.length > 0 ? { enabledTools } : {})
          },
          sendChatHistory
        });

        if (!inputText) {
          setInputValue('');
        }
      } catch (error) {
        console.error('Error sending prompt:', error);
        addSystemMessage(
          `Error: ${t('error.sendMessageFailed', 'Failed to send message.')} ${
            error.message || t('error.tryAgain', 'Please try again.')
          }`,
          true
        );
      }
    },
    // eslint-disable-next-line @eslint-react/exhaustive-deps
    [
      inputValue,
      processing,
      selectedText,
      editorContent,
      sendChatMessage,
      addSystemMessage,
      selectedModel,
      selectedStyle,
      temperature,
      selectedOutputFormat,
      currentLanguage,
      sendChatHistory,
      t
    ]
  );

  // Keep the ref in sync so stableSubmitForwarder always calls the latest version
  handlePromptSubmitRef.current = handlePromptSubmit;

  // Voice commands setup
  useVoiceCommands({
    messages,
    clearChat: () => {
      clearMessages();
      clearCanvasContent();
      chatId.current = resetChatId(appId, 'canvas');
    },
    sendMessage: text => {
      handlePromptSubmit(text);
    },
    isProcessing: processing,
    currentText: '',
    setInput: () => {}
  });

  // Resend message functionality for ChatInput
  const handleResendMessage = useCallback(
    (messageId, editedContent) => {
      const resendData = prepareResend(messageId, editedContent);
      const { content: text } = resendData;

      if (text || app?.allowEmptyContent) {
        handlePromptSubmit(text || '');
      }
    },
    [prepareResend, handlePromptSubmit, app?.allowEmptyContent]
  );

  // Load app data
  useEffect(() => {
    let isMounted = true;

    const loadApp = async () => {
      try {
        setLoading(true);

        // Load app data
        const appData = await fetchAppDetails(appId);

        if (!isMounted) return;

        setApp(appData);
        setError(null);
      } catch (err) {
        console.error('Failed to load app:', err);
        if (isMounted) {
          setError(
            t('error.failedToLoadApp', 'Failed to load application data. Please try again later.')
          );
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadApp();
    return () => {
      isMounted = false;
    };
  }, [appId, t]);

  // Cleanup event source when component unmounts
  useEffect(() => {
    return () => {
      cancelGeneration();
    };
  }, [cancelGeneration]);

  // Save settings when they change (same as AppChat)
  useEffect(() => {
    if (app) {
      // Additional canvas-specific settings can be saved here
      // The main app settings are handled by useAppSettings hook
    }
  }, [app]);

  // Handle resizing panels
  const handleMouseDown = useCallback(e => {
    setIsDragging(true);
    e.preventDefault();
  }, []);

  const handleMouseMove = useCallback(
    e => {
      if (!isDragging) return;

      const containerWidth = window.innerWidth;
      const newChatWidth = Math.max(20, Math.min(60, (e.clientX / containerWidth) * 100));

      setPanelSizes({
        chat: newChatWidth,
        canvas: 100 - newChatWidth
      });
    },
    [isDragging]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Handle canceling/stopping the current request
  const handleCancel = useCallback(() => {
    cancelGeneration();
    window.pendingEdit = null;
  }, [cancelGeneration]);

  // Handle input change for controlled input
  const handleInputChange = useCallback(e => {
    setInputValue(e.target.value);
  }, []);

  // Handle content modal actions
  const handleContentModalReplace = useCallback(() => {
    if (contentModalData?.onReplace) {
      contentModalData.onReplace();
    }
    setShowContentModal(false);
    setContentModalData(null);
  }, [contentModalData]);

  const handleContentModalAppend = useCallback(() => {
    if (contentModalData?.onAppend) {
      contentModalData.onAppend();
    }
    setShowContentModal(false);
    setContentModalData(null);
  }, [contentModalData]);

  const handleContentModalCancel = useCallback(() => {
    if (contentModalData?.onCancel) {
      contentModalData.onCancel();
    }
    setShowContentModal(false);
    setContentModalData(null);
  }, [contentModalData]);

  // Helper functions

  const clearCanvas = () => {
    if (
      window.confirm(
        t('canvas.confirmClear', 'Are you sure you want to clear the document and chat history?')
      )
    ) {
      clearCanvasContent();
      clearMessages();
      chatId.current = resetChatId(appId, 'canvas');
    }
  };

  const toggleConfig = () => {
    setShowConfig(!showConfig);
  };

  const clearSelectedText = useCallback(() => {
    setSelection(null);
    setSelectedText('');
    if (quillRef.current) {
      const quill = quillRef.current.getEditor();
      quill.setSelection(null);
    }
  }, [setSelectedText, setSelection]);

  const handleInsertAnswer = useCallback(
    text => {
      if (!quillRef.current || !text) return;
      const quill = quillRef.current.getEditor();
      const html = isMarkdown(text) ? markdownToHtml(text) : text;
      const index = selection ? selection.index : cursorPosition;
      if (selection && selection.length > 0) {
        quill.deleteText(selection.index, selection.length);
      }
      quill.clipboard.dangerouslyPasteHTML(index, html);
      quill.setSelection(index + html.length, 0);
      setEditorContent(quill.root.innerHTML);
      setSelection(null);
      setSelectedText('');
    },
    [quillRef, selection, cursorPosition, setEditorContent, setSelectedText, setSelection]
  );

  // Handle voice input for canvas editor
  const handleCanvasVoiceInput = useCallback(() => {
    // The text is already inserted into the editor by CanvasVoiceInput component
    // We just need to trigger a content update to ensure parent state is synchronized
    if (quillRef.current) {
      const quill = quillRef.current.getEditor();
      const currentContent = quill.root.innerHTML;
      setEditorContent(currentContent);
    }
  }, [setEditorContent]);

  // Voice recognition for the canvas chat panel (dictate instructions to the LLM)
  const {
    isListening: isChatVoiceListening,
    transcript: chatVoiceTranscript,
    toggleListening: toggleChatVoice,
    stopListening: stopChatVoice,
    microphoneMode: chatMicrophoneMode
  } = useVoiceRecognition({
    app,
    inputRef: chatInputRef,
    onSpeechResult: text => {
      setInputValue(prev => (prev ? `${prev} ${text}` : text));
    },
    disabled: processing
  });

  // Track which message IDs have already been auto-applied to avoid re-applying on re-render
  const lastAutoAppliedMsgIdRef = useRef(null);

  // Auto-apply: when canvasAutoApply is enabled, automatically update the editor with LLM responses
  useEffect(() => {
    if (!app?.features?.canvasAutoApply) return;
    if (!messages || messages.length === 0) return;

    const lastMsg = messages[messages.length - 1];
    // Only act on completed assistant messages — skip FloatingToolbox edit actions (they handle
    // content themselves via applyEditResult) and skip while still streaming
    if (
      lastMsg?.role !== 'assistant' ||
      lastMsg?.meta?.editAction ||
      lastMsg?.isStreaming ||
      lastMsg?.id === lastAutoAppliedMsgIdRef.current
    ) {
      return;
    }

    const msgContent = lastMsg?.content;
    if (!msgContent) return;

    const html = isMarkdown(msgContent) ? markdownToHtml(msgContent) : msgContent;
    setEditorContent(html);
    lastAutoAppliedMsgIdRef.current = lastMsg.id;
  }, [messages, app?.features?.canvasAutoApply, setEditorContent]);

  // Save canvas-specific settings when they change
  useEffect(() => {
    if (appId) {
      sessionStorage.setItem(`canvas_panel_sizes_${appId}`, JSON.stringify(panelSizes));
    }
  }, [appId, panelSizes]);

  // Load canvas-specific settings on mount
  useEffect(() => {
    // Load canvas-specific settings from sessionStorage
    // Main app settings are handled by useAppSettings hook
    // Document content is handled by useCanvasContent hook
    const loadSettings = () => {
      // Load panel sizes
      const savedPanelSizes = sessionStorage.getItem(`canvas_panel_sizes_${appId}`);
      if (savedPanelSizes) {
        try {
          setPanelSizes(JSON.parse(savedPanelSizes));
        } catch (error) {
          console.error('Error loading panel sizes:', error);
        }
      }
    };

    loadSettings();
  }, [appId]);

  // Handle initial content when redirected from chat (content stored in sessionStorage)
  useEffect(() => {
    const hasContent = searchParams.get('hasContent');
    if (!hasContent) return;

    const storageKey = `canvas_initial_content_${appId}`;
    const initialContent = sessionStorage.getItem(storageKey);

    // Always clear the URL flag and sessionStorage entry regardless of outcome
    const newSearchParams = new URLSearchParams(searchParams);
    newSearchParams.delete('hasContent');
    navigate(`/apps/${appId}/canvas?${newSearchParams.toString()}`, { replace: true });
    sessionStorage.removeItem(storageKey);

    if (!initialContent) return;

    const contentToSet = isMarkdown(initialContent)
      ? markdownToHtml(initialContent)
      : initialContent;

    const loadInitialContent = async () => {
      try {
        await setContentWithConfirmation(contentToSet, modalData => {
          setContentModalData({
            ...modalData,
            title: t('canvas.confirmReplaceWithNewContentTitle', 'Content from Chat')
          });
          setShowContentModal(true);
        });
      } catch (error) {
        console.error('Error loading initial content:', error);
      }
    };

    loadInitialContent();
  }, [searchParams, appId, navigate, setContentWithConfirmation, t]);

  if (loading) {
    return <LoadingSpinner message={t('app.loading')} />;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg max-w-md">
          <p className="font-bold">{t('pages.appCanvas.errorTitle', 'Error')}</p>
          <p>{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded"
          >
            {t('common.retry', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="canvas-container flex flex-col h-[calc(100vh-5rem)] max-h-[calc(100vh-5rem)] min-h-0 overflow-hidden pt-4 pb-2 bg-white">
      {/* Shared Header */}
      <SharedAppHeader
        app={app}
        appId={appId}
        mode="canvas"
        messages={messages}
        editorContent={editorContent}
        onClearCanvas={clearCanvas}
        currentLanguage={currentLanguage}
        models={models}
        styles={styles}
        selectedModel={selectedModel}
        selectedStyle={selectedStyle}
        selectedOutputFormat={selectedOutputFormat}
        sendChatHistory={sendChatHistory}
        temperature={temperature}
        enabledTools={enabledTools}
        onModelChange={setSelectedModel}
        onStyleChange={setSelectedStyle}
        onOutputFormatChange={setSelectedOutputFormat}
        onSendChatHistoryChange={setSendChatHistory}
        onTemperatureChange={setTemperature}
        onEnabledToolsChange={setEnabledTools}
        showConfig={showConfig}
        onToggleConfig={toggleConfig}
        onShare={() => setShowShare(true)}
        showShareButton={shareEnabled}
      />

      {/* Main Content Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden gap-2 px-4 pb-4">
        {/* Voice feedback overlay for chat panel dictation */}
        <VoiceFeedback
          isActive={isChatVoiceListening}
          setIsActive={stopChatVoice}
          transcript={
            app?.inputMode?.microphone?.showTranscript || app?.microphone?.showTranscript
              ? chatVoiceTranscript
              : ''
          }
          mode={chatMicrophoneMode}
        />

        {/* Chat Panel */}
        <CanvasChatPanel
          messages={messages}
          inputValue={inputValue}
          onInputChange={handleInputChange}
          onSubmit={handlePromptSubmit}
          isProcessing={processing}
          onCancel={handleCancel}
          onDelete={deleteMessage}
          onEdit={editMessage}
          onResend={handleResendMessage}
          app={app}
          appId={appId}
          chatId={chatId.current}
          selectedText={selectedText}
          onClearSelection={clearSelectedText}
          width={panelSizes.chat}
          inputRef={chatInputRef}
          onInsertAnswer={handleInsertAnswer}
          modelId={selectedModel}
          models={models}
          onVoiceInput={toggleChatVoice}
        />

        {/* Resize Handle */}
        <div
          className="canvas-resize-handle w-1 bg-gray-300 hover:bg-gray-400 cursor-col-resize flex-shrink-0 rounded-full"
          onMouseDown={handleMouseDown}
        />

        {/* Canvas Panel */}
        <CanvasEditor
          content={editorContent}
          onContentChange={setEditorContent}
          onSelectionChange={handleSelectionChange}
          processing={processing}
          showExportMenu={showExportMenu}
          onToggleExportMenu={setShowExportMenu}
          editorRef={quillRef}
          width={panelSizes.canvas}
          app={app}
          onVoiceInput={handleCanvasVoiceInput}
        />
      </div>

      {/* Floating Toolbox */}
      {app && !loading && (
        <FloatingToolbox
          onAction={(action, description) =>
            handleEditAction(action, description, selectedText, currentLanguage)
          }
          isProcessing={processing}
          hasSelection={!!selectedText}
          editorContent={editorContent}
        />
      )}

      {/* Content Confirmation Modal */}
      <CanvasContentConfirmationModal
        isOpen={showContentModal}
        currentContent={contentModalData?.currentContent || ''}
        newContent={contentModalData?.newContent || ''}
        title={contentModalData?.title}
        onConfirm={handleContentModalReplace}
        onAppend={handleContentModalAppend}
        onCancel={handleContentModalCancel}
      />
      {shareEnabled && showShare && (
        <AppShareModal
          appId={appId}
          path={window.location.pathname}
          params={{
            model: selectedModel,
            style: selectedStyle,
            outfmt: selectedOutputFormat,
            temp: temperature,
            history: sendChatHistory
          }}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}
