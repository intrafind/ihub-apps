import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Custom hook for managing canvas document content
 * Content will persist during page refreshes using sessionStorage
 * Each app will have its own content storage
 * 
 * @param {string} appId - The ID of the current app for storage purposes
 * @param {Function} onContentChange - Callback when content changes
 * @returns {Object} Canvas content management functions and state
 */
function useCanvasContent(appId, onContentChange) {
  // Use sessionStorage for persistence during page refreshes
  const storageKey = `ai_hub_canvas_content_${appId}`;
  const lastSavedKey = `ai_hub_canvas_last_saved_${appId}`;
  
  // Initialize state from sessionStorage if available
  const loadInitialContent = () => {
    try {
      const storedContent = sessionStorage.getItem(storageKey);
      return storedContent || '';
    } catch (error) {
      console.error('Error loading canvas content from sessionStorage:', error);
      return '';
    }
  };

  const [content, setContent] = useState(loadInitialContent);
  const [lastSaved, setLastSaved] = useState(() => {
    try {
      const saved = sessionStorage.getItem(lastSavedKey);
      return saved ? new Date(saved) : null;
    } catch (error) {
      return null;
    }
  });
  
  // Use a ref to store the current content for immediate access
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

  // Update content with change notification
  const updateContent = useCallback((newContent) => {
    setContent(newContent);
    if (onContentChange) {
      onContentChange(newContent);
    }
  }, [onContentChange]);

  // Check if there's existing content
  const hasContent = useCallback(() => {
    return contentRef.current && contentRef.current.trim().length > 0;
  }, []);

  // Get content without HTML tags for text comparison
  const getTextContent = useCallback(() => {
    return contentRef.current.replace(/<[^>]*>/g, '').trim();
  }, []);

  // Clear content
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

  // Set content with optional confirmation for existing content
  const setContentWithConfirmation = useCallback((newContent, onShowModal) => {
    // If there's no existing content, just set it
    if (!hasContent()) {
      updateContent(newContent);
      return Promise.resolve('replaced');
    }

    // If no modal handler provided, just replace (backward compatibility)
    if (!onShowModal) {
      updateContent(newContent);
      return Promise.resolve('replaced');
    }

    // Show modal and return promise that resolves with user's choice
    return new Promise((resolve) => {
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
  }, [hasContent, updateContent]);

  // Append content to existing content
  const appendContent = useCallback((newContent, separator = '\n\n') => {
    const currentContent = contentRef.current;
    const updatedContent = currentContent 
      ? currentContent + separator + newContent 
      : newContent;
    updateContent(updatedContent);
  }, [updateContent]);

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

  return {
    content,
    setContent: updateContent,
    setContentWithConfirmation,
    appendContent,
    clearContent,
    hasContent,
    getTextContent,
    lastSaved,
    getStorageInfo
  };
}

export default useCanvasContent;
