import { useCallback } from 'react';
import { markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';

/**
 * Custom hook for applying AI edit results to the canvas
 */
const useCanvasEditResult = ({ quillRef, selection, setSelection, setSelectedText }) => {
  // Apply AI edit results to the canvas
  const applyEditResult = useCallback(
    (editedText, action = null) => {
      if (!editedText) return;

      const editor = quillRef.current.getEditor();

      // For "suggest" action, don't replace text automatically
      if (action === 'suggest') {
        // Show the suggestion in the chat only, don't modify the document
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
    [quillRef, selection, setSelection, setSelectedText]
  );

  return {
    applyEditResult
  };
};

export default useCanvasEditResult;
