import { useEffect } from 'react';
import { getFileExtension } from '../utils/markdownHelpers';

// Helper to provide temporary feedback on a button
const showButtonFeedback = (button, message, isSuccess = true) => {
  const originalHTML = button.innerHTML;
  const successIcon = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`;
  const errorIcon = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>`;
  
  button.innerHTML = `
    ${isSuccess ? successIcon : errorIcon}
    <span class="hidden sm:inline">${message}</span>
  `;
  button.classList.toggle('text-green-600', isSuccess);
  button.classList.toggle('text-red-600', !isSuccess);
  button.classList.remove('text-gray-600');
  button.disabled = true;

  setTimeout(() => {
    button.innerHTML = originalHTML;
    button.classList.remove('text-green-600', 'text-red-600');
    button.classList.add('text-gray-600');
    button.disabled = false;
  }, 2000);
};

export const useCodeBlockInteractions = () => {
  useEffect(() => {
    const handleInteraction = (e) => {
      const button = e.target.closest('button');
      if (!button) return;

      const isCopyBtn = button.classList.contains('code-copy-btn');
      const isDownloadBtn = button.classList.contains('code-download-btn');

      if (!isCopyBtn && !isDownloadBtn) return;
      
      // Get code content from data attribute or fallback to DOM extraction
      let codeContent = button.dataset.codeContent;
      if (!codeContent || codeContent === '[object Object]') {
        const codeEl = button.closest('.code-block-container')?.querySelector('pre code');
        codeContent = codeEl ? codeEl.textContent : '';
      } else {
        codeContent = decodeURIComponent(codeContent);
      }

      if (isCopyBtn) {
        navigator.clipboard.writeText(codeContent)
          .then(() => showButtonFeedback(button, 'Copied!', true))
          .catch((err) => {
            console.error('Failed to copy code block:', err);
            showButtonFeedback(button, 'Error', false);
          });
      }

      if (isDownloadBtn) {
        try {
          const language = button.dataset.codeLanguage || 'text';
          const fileExtension = getFileExtension(language);
          const blob = new Blob([codeContent], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `code.${fileExtension}`;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showButtonFeedback(button, 'Downloaded!', true);
        } catch (err) {
          console.error('Download failed:', err);
          showButtonFeedback(button, 'Error', false);
        }
      }
    };

    document.addEventListener('click', handleInteraction);
    return () => document.removeEventListener('click', handleInteraction);
  }, []);
};