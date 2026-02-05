import { useState } from 'react';
import TurndownService from 'turndown';

const turndownService = new TurndownService();

/**
 * Custom hook for clipboard operations with multiple format support.
 * Supports copying content as plain text, markdown, HTML, or JSON.
 * @returns {Object} Clipboard utilities
 * @returns {Function} returns.copyText - Copy content as plain text
 * @returns {Function} returns.copyMarkdown - Copy HTML content as markdown
 * @returns {Function} returns.copyHTML - Copy content as rich HTML
 * @returns {Function} returns.copyJSON - Copy data as formatted JSON
 * @returns {boolean} returns.isLoading - Whether a copy operation is in progress
 * @returns {string|null} returns.lastCopied - Type of last successful copy ('text'|'markdown'|'html'|'json')
 */
export const useClipboard = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [lastCopied, setLastCopied] = useState(null);

  const copyText = async content => {
    setIsLoading(true);
    try {
      // Convert HTML to plain text if needed
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = content;
      const plainText = tempDiv.textContent || tempDiv.innerText || '';

      await navigator.clipboard.writeText(plainText);
      setLastCopied('text');
      console.log('✅ Text copied to clipboard');
      return { success: true, type: 'text' };
    } catch (error) {
      console.error('Failed to copy text:', error);
      return { success: false, error };
    } finally {
      setIsLoading(false);
    }
  };

  const copyMarkdown = async content => {
    setIsLoading(true);
    try {
      const markdown = turndownService.turndown(content);
      await navigator.clipboard.writeText(markdown);
      setLastCopied('markdown');
      console.log('✅ Markdown copied to clipboard');
      return { success: true, type: 'markdown' };
    } catch (error) {
      console.error('Failed to copy markdown:', error);
      return { success: false, error };
    } finally {
      setIsLoading(false);
    }
  };

  const copyHTML = async content => {
    setIsLoading(true);
    try {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = content;
      const plain = tempDiv.textContent || tempDiv.innerText || '';
      const hasClipboardWrite = navigator.clipboard && navigator.clipboard.write;

      if (hasClipboardWrite) {
        const item = new ClipboardItem({
          'text/html': new Blob([content], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        });
        await navigator.clipboard.write([item]);
      } else {
        await navigator.clipboard.writeText(content);
      }

      setLastCopied('html');
      console.log('✅ HTML copied to clipboard');
      return { success: true, type: 'html' };
    } catch (error) {
      console.error('Failed to copy HTML:', error);
      return { success: false, error };
    } finally {
      setIsLoading(false);
    }
  };

  const copyJSON = async data => {
    setIsLoading(true);
    try {
      const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(jsonString);
      setLastCopied('json');
      console.log('✅ JSON copied to clipboard');
      return { success: true, type: 'json' };
    } catch (error) {
      console.error('Failed to copy JSON:', error);
      return { success: false, error };
    } finally {
      setIsLoading(false);
    }
  };

  return {
    copyText,
    copyMarkdown,
    copyHTML,
    copyJSON,
    isLoading,
    lastCopied
  };
};

export default useClipboard;
