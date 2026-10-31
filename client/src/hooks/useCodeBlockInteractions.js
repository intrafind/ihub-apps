// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { codeDownloadName } from '../utils/markdownHelpers';
import { saveBlobAs } from '../utils/externalNavigation';

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

/** The name a code block's download button saves under (see `codeDownloadName`). */
const downloadNameOf = button => {
  try {
    const encoded = button.dataset.codeFilename;
    if (encoded) return decodeURIComponent(encoded);
  } catch {
    // A malformed attribute falls back to the language's default name.
  }
  return codeDownloadName('', button.dataset.codeLanguage || 'text');
};

export const useCodeBlockInteractions = () => {
  const { t } = useTranslation();
  useEffect(() => {
    const handleInteraction = e => {
      const button = e.target.closest('button');
      if (!button) return;

      const isCopyBtn = button.classList.contains('code-copy-btn');
      const isDownloadBtn = button.classList.contains('code-download-btn');

      if (!isCopyBtn && !isDownloadBtn) return;

      // Get code content from data attribute or fallback to DOM extraction
      let codeContent = button.dataset.codeContent;
      if (!codeContent || codeContent === '[object Object]' || codeContent === 'undefined') {
        const codeEl = button.closest('.code-block-container')?.querySelector('pre > code');
        codeContent = codeEl ? codeEl.textContent : '';
      } else {
        try {
          codeContent = decodeURIComponent(codeContent);
        } catch (err) {
          console.warn('Failed to decode code content:', err);
          const codeEl = button.closest('.code-block-container')?.querySelector('pre > code');
          codeContent = codeEl ? codeEl.textContent : '';
        }
      }

      // Clean up the extracted content
      codeContent = codeContent.trim();

      if (isCopyBtn) {
        navigator.clipboard
          .writeText(codeContent)
          .then(() => showButtonFeedback(button, t('common.copied', 'Copied!'), true))
          .catch(err => {
            console.error('Failed to copy code block:', err);
            showButtonFeedback(button, t('common.error', 'Error'), false);
          });
      }

      if (isDownloadBtn) {
        const blob = new Blob([codeContent], { type: 'text/plain' });
        if (saveBlobAs(blob, downloadNameOf(button))) {
          showButtonFeedback(button, t('common.downloaded', 'Downloaded!'), true);
        } else {
          showButtonFeedback(button, t('common.error', 'Error'), false);
        }
      }
    };

    document.addEventListener('click', handleInteraction);
    return () => document.removeEventListener('click', handleInteraction);
  }, [t]);
};
