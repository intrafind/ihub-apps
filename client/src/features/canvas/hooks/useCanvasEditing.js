import { useCallback } from 'react';

/**
 * Custom hook for managing canvas text editing actions
 */
const useCanvasEditing = ({
  quillRef,
  selection,
  setSelection,
  setSelectedText,
  setCursorPosition,
  handlePromptSubmit,
  chatInputRef
}) => {
  // Handle text selection in the editor
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
        // Reset selection state on error
        setSelection(null);
        setSelectedText('');
      }
    },
    [setSelection, setSelectedText, setCursorPosition, chatInputRef]
  );

  // Handle edit toolbar actions - bypass app prompts and use direct AI instructions
  const handleEditAction = useCallback(
    async(action, description, selectedText, currentLanguage) => {
      // For actions that don't require selection (like continue, summarize, outline)
      const noSelectionActions = ['continue', 'summarize', 'outline'];

      if (!noSelectionActions.includes(action) && (!selectedText || !selection)) return;

      // Create a direct prompt for the edit action, bypassing app configuration
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

      // Use the regular prompt submission with edit context - pass prompt as string
      await handlePromptSubmit(prompt, {
        editAction: action,
        originalText: selectedText,
        bypassAppPrompts: true // Flag to bypass app configuration
      });
    },
    [selection, handlePromptSubmit]
  );

  return {
    handleSelectionChange,
    handleEditAction
  };
};

export default useCanvasEditing;
