import { useState } from 'react';
import TurndownService from 'turndown';
import * as clipboardUtils from '../../utils/clipboardUtils.js';

const turndownService = new TurndownService();

/**
 * Custom hook for clipboard operations with multiple format support.
 * Supports copying content as plain text, markdown, HTML, or JSON.
 * Includes iframe support via postMessage fallback.
 * @returns {Object} Clipboard utilities
 * @returns {Function} returns.copyText - Copy content as plain text
 * @returns {Function} returns.copyMarkdown - Copy HTML content as markdown
 * @returns {Function} returns.copyHTML - Copy content as rich HTML
 * @returns {Function} returns.copyJSON - Copy data as formatted JSON
 * @returns {boolean} returns.isLoading - Whether a copy operation is in progress
 * @returns {string|null} returns.lastCopied - Type of last successful copy ('text'|'markdown'|'html'|'json')
 */
export function useClipboard() {
  const [isLoading, setIsLoading] = useState(false);
  const [lastCopied, setLastCopied] = useState(null);

  const copyText = async content => {
    setIsLoading(true);
    try {
      // Convert HTML to plain text if needed
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = content;
      const plainText = tempDiv.textContent || tempDiv.innerText || '';

      const result = await clipboardUtils.copyText(plainText);
      if (result.success) {
        setLastCopied('text');
        console.log('✅ Text copied to clipboard');
      }
      return { success: result.success, type: 'text', ...result };
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
      const result = await clipboardUtils.copyMarkdown(markdown);
      if (result.success) {
        setLastCopied('markdown');
        console.log('✅ Markdown copied to clipboard');
      }
      return { success: result.success, type: 'markdown', ...result };
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

      const result = await clipboardUtils.copyHTML(content, plain);
      if (result.success) {
        setLastCopied('html');
        console.log('✅ HTML copied to clipboard');
      }
      return { success: result.success, type: 'html', ...result };
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
      const result = await clipboardUtils.copyJSON(data);
      if (result.success) {
        setLastCopied('json');
        console.log('✅ JSON copied to clipboard');
      }
      return { success: result.success, type: 'json', ...result };
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
}

export default useClipboard;
