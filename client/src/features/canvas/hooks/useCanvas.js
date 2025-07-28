import { useState, useCallback, useRef, useEffect } from 'react';
import { markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';

/**
 * Unified canvas hook that combines content management, editing, and edit result application
 *
 * @param {string} appId - The ID of the current app for storage purposes
 * @param {Function} onContentChange - Callback when content changes
 * @param {Object} refs - Object containing quillRef and chatInputRef
 * @param {Function} handlePromptSubmit - Function to handle prompt submission
 * @returns {Object} Complete canvas management API
 */
function useCanvas(appId, onContentChange, refs = {}, handlePromptSubmit) {
  const { quillRef, chatInputRef } = refs;

  // Storage keys for persistence
  const storageKey = `ai_hub_canvas_content_${appId}`;
  const lastSavedKey = `ai_hub_canvas_last_saved_${appId}`;

  // Initialize content from sessionStorage
  const loadInitialContent = () => {
    try {
      const storedContent = sessionStorage.getItem(storageKey);
      return storedContent || '';
    } catch (error) {
      console.error('Error loading canvas content from sessionStorage:', error);
      return '';
    }
  };

  // Content management state
  const [content, setContent] = useState(loadInitialContent);
  const [lastSaved, setLastSaved] = useState(() => {
    try {
      const saved = sessionStorage.getItem(lastSavedKey);
      return saved ? new Date(saved) : null;
    } catch {
      return null;
    }
  });

  // Editing state
  const [selection, setSelection] = useState(null);
  const [selectedText, setSelectedText] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);

  // Content ref for immediate access
  const contentRef = useRef(content);

  // Update the ref whenever content changes
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Save content to sessionStorage whenever it changes
  useEffect(() => {
    try {
      if (content !== undefined) {
        sessionStorage.setItem(storageKey, content);
        const now = new Date();
        sessionStorage.setItem(lastSavedKey, now.toISOString());
        setLastSaved(now);
      }
    } catch (error) {
      console.error('Error saving canvas content to sessionStorage:', error);
    }
  }, [content, storageKey, lastSavedKey]);

  // Content management functions
  const updateContent = useCallback(
    newContent => {
      setContent(newContent);
      if (onContentChange) {
        onContentChange(newContent);
      }
    },
    [onContentChange]
  );

  const hasContent = useCallback(() => {
    return contentRef.current && contentRef.current.trim().length > 0;
  }, []);

  const getTextContent = useCallback(() => {
    return contentRef.current.replace(/<[^>]*>/g, '').trim();
  }, []);

  const clearContent = useCallback(() => {
    setContent('');
    try {
      sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(lastSavedKey);
      setLastSaved(null);
    } catch (error) {
      console.error('Error clearing canvas content from sessionStorage:', error);
    }
    if (onContentChange) {
      onContentChange('');
    }
  }, [storageKey, lastSavedKey, onContentChange]);

  const setContentWithConfirmation = useCallback(
    (newContent, onShowModal) => {
      if (!hasContent()) {
        updateContent(newContent);
        return Promise.resolve('replaced');
      }

      if (!onShowModal) {
        updateContent(newContent);
        return Promise.resolve('replaced');
      }

      return new Promise(resolve => {
        onShowModal({
          currentContent: contentRef.current,
          newContent,
          onReplace: () => {
            updateContent(newContent);
            resolve('replaced');
          },
          onAppend: () => {
            const separator = '\n\n';
            const updatedContent = contentRef.current + separator + newContent;
            updateContent(updatedContent);
            resolve('appended');
          },
          onCancel: () => {
            resolve('cancelled');
          }
        });
      });
    },
    [hasContent, updateContent]
  );

  const appendContent = useCallback(
    (newContent, separator = '\n\n') => {
      const currentContent = contentRef.current;
      const updatedContent = currentContent ? currentContent + separator + newContent : newContent;
      updateContent(updatedContent);
    },
    [updateContent]
  );

  // Editing functions
  const handleSelectionChange = useCallback(
    (range, source, editor) => {
      try {
        if (range) {
          setCursorPosition(range.index);
        }
        if (range && range.length > 0) {
          const selectedText = editor.getText(range.index, range.length);
          setSelection(range);
          setSelectedText(selectedText.trim());
        } else {
          // Preserve selection when the chat input is focused
          const active = document.activeElement;
          const inputElem = chatInputRef?.current;
          if (inputElem && (active === inputElem || inputElem.contains(active))) {
            return;
          }
          setSelection(null);
          setSelectedText('');
        }
      } catch (error) {
        console.warn('Selection change error:', error);
        setSelection(null);
        setSelectedText('');
      }
    },
    [chatInputRef]
  );

  const handleEditAction = useCallback(
    async (action, description, selectedText, currentLanguage) => {
      const noSelectionActions = ['continue', 'summarize', 'outline'];

      if (!noSelectionActions.includes(action) && (!selectedText || !selection)) return;

      let prompt;
      switch (action) {
        case 'continue':
          prompt =
            'Please continue writing from where the document left off, maintaining the same style and tone.';
          break;
        case 'summarize':
          prompt = 'Please provide a concise summary of the entire document.';
          break;
        case 'outline':
          prompt = 'Please create an outline of the main points in this document.';
          break;
        case 'expand':
          prompt = `Please expand and elaborate on the following text, making it longer and more detailed while maintaining the same meaning and tone:\n\n"${selectedText}"`;
          break;
        case 'condense':
          prompt = `Please condense and summarize the following text, making it shorter and more concise while preserving the key information:\n\n"${selectedText}"`;
          break;
        case 'paraphrase':
          prompt = `Please paraphrase the following text using different words while maintaining the same meaning:\n\n"${selectedText}"`;
          break;
        case 'clarify':
          prompt = `Please rewrite the following text to make it clearer and easier to understand:\n\n"${selectedText}"`;
          break;
        case 'formal':
          prompt = `Please rewrite the following text in a more formal and professional tone:\n\n"${selectedText}"`;
          break;
        case 'casual':
          prompt = `Please rewrite the following text in a more casual and friendly tone:\n\n"${selectedText}"`;
          break;
        case 'professional':
          prompt = `Please rewrite the following text in a more professional and business-appropriate tone:\n\n"${selectedText}"`;
          break;
        case 'creative':
          prompt = `Please rewrite the following text in a more creative and engaging way:\n\n"${selectedText}"`;
          break;
        case 'translate':
          prompt = `Please translate the following text to ${currentLanguage === 'en' ? 'Spanish' : 'English'} and only respond with the translated text:\n\n"${selectedText}"`;
          break;
        case 'grammar':
          prompt = `Please check and fix any grammar issues in the following text:\n\n"${selectedText}"`;
          break;
        case 'format':
          prompt = `Please format and structure the following text properly:\n\n"${selectedText}"`;
          break;
        case 'suggest':
          prompt = `Please provide suggestions for improving the following text (don't rewrite it, just give advice):\n\n"${selectedText}"`;
          break;
        default:
          prompt = `${description}: "${selectedText}"`;
      }

      // Mark this as an edit operation
      window.pendingEdit = { action, selection, selectedText };

      // Use the regular prompt submission with edit context
      if (handlePromptSubmit) {
        await handlePromptSubmit(prompt, {
          editAction: action,
          originalText: selectedText,
          bypassAppPrompts: true
        });
      }
    },
    [selection, handlePromptSubmit]
  );

  // Edit result application function
  const applyEditResult = useCallback(
    (editedText, action = null) => {
      if (!editedText || !quillRef?.current) return;

      const editor = quillRef.current.getEditor();

      // For "suggest" action, don't replace text automatically
      if (action === 'suggest') {
        return;
      }

      // Convert markdown to HTML if the response appears to be markdown
      let contentToInsert = editedText;
      if (isMarkdown(editedText)) {
        contentToInsert = markdownToHtml(editedText);
      }

      if (selection && selection.index !== undefined && selection.length !== undefined) {
        // Replace the selected text with the edited version
        editor.deleteText(selection.index, selection.length);

        // Insert HTML content using clipboard API to preserve formatting
        const delta = editor.clipboard.convert(contentToInsert);
        editor.updateContents(delta, 'user');
        editor.setSelection(selection.index + delta.length());
      } else {
        // No selection, append to the end of the document
        const currentLength = editor.getLength();

        // Add some spacing if document isn't empty
        if (currentLength > 1) {
          contentToInsert = '\n\n' + contentToInsert;
        }

        if (isMarkdown(contentToInsert)) {
          const delta = editor.clipboard.convert(contentToInsert);
          editor.updateContents(delta, 'user');
        } else {
          editor.insertText(currentLength - 1, contentToInsert);
        }

        // Scroll to bottom
        editor.setSelection(editor.getLength());
      }

      // Clear selection and hide toolbar
      setSelection(null);
      setSelectedText('');
    },
    [quillRef, selection]
  );

  // Get storage info for debugging
  const getStorageInfo = useCallback(() => {
    return {
      storageKey,
      lastSavedKey,
      hasStoredContent: !!sessionStorage.getItem(storageKey),
      lastSaved,
      contentLength: content.length,
      textContentLength: getTextContent().length
    };
  }, [storageKey, lastSavedKey, lastSaved, content.length, getTextContent]);

  // Clear pending edit
  const clearPendingEdit = useCallback(() => {
    window.pendingEdit = null;
  }, []);

  return {
    // Content management
    content,
    setContent: updateContent,
    setContentWithConfirmation,
    appendContent,
    clearContent,
    hasContent,
    getTextContent,
    lastSaved,
    getStorageInfo,

    // Editing state
    selection,
    selectedText,
    cursorPosition,
    setSelection,
    setSelectedText,
    setCursorPosition,

    // Editing functions
    handleSelectionChange,
    handleEditAction,
    applyEditResult,
    clearPendingEdit
  };
}

export default useCanvas;
