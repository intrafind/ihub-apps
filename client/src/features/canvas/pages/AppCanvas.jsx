import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// Import components
import ChatMessageList from '../../chat/components/ChatMessageList';
import ChatInput from '../../chat/components/ChatInput';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
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
import useCanvasEditing from '../hooks/useCanvasEditing';
import useAppSettings from '../../../shared/hooks/useAppSettings';
import useCanvasContent from '../hooks/useCanvasContent';
import { fetchAppDetails } from '../../../api/api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';
import { getOrCreateChatId, resetChatId } from '../../../utils/chatId';

// Import AI-assisted canvas specific styles
import './AppCanvas.css';

const AppCanvas = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { appId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { uiConfig } = useUIConfig();

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
    models,
    styles,
    setSelectedModel,
    setSelectedStyle,
    setSelectedOutputFormat,
    setTemperature,
    setSendChatHistory,
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
  }, [app, modelsLoading]);

  // Canvas editor states
  const [selection, setSelection] = useState(null);
  const [selectedText, setSelectedText] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Canvas content management hook
  const {
    content: editorContent,
    setContent: setEditorContent,
    setContentWithConfirmation,
    appendContent,
    clearContent: clearCanvasContent,
    hasContent,
    getTextContent,
    lastSaved: contentLastSaved,
    getStorageInfo
  } = useCanvasContent(appId, null);

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

  // Handle general prompt submission - simplified to match AppChat
  const handlePromptSubmit = useCallback(
    async(e, options = {}) => {
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
        contextualInput += `\n\nCurrent document context: ${editorContent.replace(/<[^>]*>/g, '').substring(0, 500)}...`;
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
            bypassAppPrompts: true
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
    [
      inputValue,
      selectedText,
      editorContent,
      sendChatMessage,
      addSystemMessage,
      appId,
      selectedModel,
      selectedStyle,
      temperature,
      selectedOutputFormat,
      currentLanguage,
      sendChatHistory,
      t
    ]
  );

  // Voice commands setup
  const { handleVoiceInput, handleVoiceCommand } = useVoiceCommands({
    messages,
    clearChat: () => {
      clearMessages();
      clearCanvasContent();
      chatId.current = resetChatId(appId, 'canvas');
    },
    sendMessage: text => {
      handlePromptSubmit(text); // This will be treated as a string input
    },
    isProcessing: processing,
    currentText: '', // Not used in canvas mode
    setInput: () => {} // Not used in canvas mode
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

  // Initialize canvas editing after handlePromptSubmit is defined
  const { handleSelectionChange, handleEditAction } = useCanvasEditing({
    quillRef,
    selection,
    setSelection,
    setSelectedText,
    setCursorPosition,
    handlePromptSubmit,
    chatInputRef
  });

  // Load app data
  useEffect(() => {
    let isMounted = true;

    const loadApp = async() => {
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

  // Apply edit result to the canvas
  const applyEditResult = useCallback(
    async(content, action) => {
      if (!content || !quillRef.current) return;

      const quill = quillRef.current.getEditor();

      try {
        switch (action) {
        case 'continue':
        case 'summarize':
        case 'outline':
          // For actions that add content, append to the end
          const currentLength = quill.getLength();
          quill.insertText(currentLength - 1, '\n\n' + content);
          break;

        case 'expand':
        case 'condense':
        case 'paraphrase':
        case 'clarify':
        case 'formal':
        case 'casual':
        case 'professional':
        case 'creative':
        case 'translate':
        case 'grammar':
        case 'format':
          // For text replacement actions, replace the selected text
          if (window.pendingEdit && window.pendingEdit.selection) {
            const { index, length } = window.pendingEdit.selection;
            quill.deleteText(index, length);
            quill.insertText(index, content);
            // Clear selection after replacement
            quill.setSelection(index + content.length, 0);
          }
          break;

        case 'suggest':
          // For suggestions, just add them to the chat - don't modify the document
          // This is handled by the chat system
          break;

        default:
          // Default behavior: append content
          const endLength = quill.getLength();
          quill.insertText(endLength - 1, '\n\n' + content);
        }

        // Update the editor content state
        const updatedContent = quill.root.innerHTML;
        setEditorContent(updatedContent);
      } catch (error) {
        console.error('Error applying edit result:', error);
        addSystemMessage(
          t('canvas.errorApplyingEdit', 'Error applying edit result. Please try again.'),
          true
        );
      }
    },
    [setEditorContent, addSystemMessage, t]
  );

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
  const handleBack = () => {
    navigate('/');
  };

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
  }, []);

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
    [quillRef, selection, cursorPosition, setEditorContent]
  );

  // Handle voice input for canvas editor
  const handleCanvasVoiceInput = useCallback(text => {
    // The text is already inserted into the editor by CanvasVoiceInput component
    // We just need to trigger a content update to ensure parent state is synchronized
    if (quillRef.current) {
      const quill = quillRef.current.getEditor();
      const currentContent = quill.root.innerHTML;
      setEditorContent(currentContent);
    }
  }, []);

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

  // Handle initial content from URL params (for auto-redirect from chat)
  useEffect(() => {
    const initialContent = searchParams.get('content');
    if (initialContent) {
      // Convert markdown to HTML if needed
      const contentToSet = isMarkdown(initialContent)
        ? markdownToHtml(initialContent)
        : initialContent;

      // Use confirmation modal if there's existing content
      const loadInitialContent = async() => {
        try {
          const result = await setContentWithConfirmation(contentToSet, modalData => {
            setContentModalData({
              ...modalData,
              title: t('canvas.confirmReplaceWithNewContentTitle', 'Content from Chat')
            });
            setShowContentModal(true);
          });

          console.log('Content loading result:', result);
        } catch (error) {
          console.error('Error loading initial content:', error);
        } finally {
          // Always clear the URL parameter regardless of user choice
          const newSearchParams = new URLSearchParams(searchParams);
          newSearchParams.delete('content');
          navigate(`/apps/${appId}/canvas?${newSearchParams.toString()}`, { replace: true });
        }
      };

      loadInitialContent();
    }
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
    <div className="canvas-container flex flex-col h-[calc(100vh-8rem)] max-h-[calc(100vh-8rem)] min-h-0 overflow-hidden pt-4 pb-2 bg-white">
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
        onModelChange={setSelectedModel}
        onStyleChange={setSelectedStyle}
        onOutputFormatChange={setSelectedOutputFormat}
        onSendChatHistoryChange={setSendChatHistory}
        onTemperatureChange={setTemperature}
        showConfig={showConfig}
        onToggleConfig={toggleConfig}
        onShare={() => setShowShare(true)}
        showShareButton={shareEnabled}
      />

      {/* Main Content Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden gap-2 px-4 pb-4">
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
};

export default AppCanvas;
