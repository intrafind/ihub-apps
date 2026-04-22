import { useCallback } from 'react';
import useAppChat from '../../chat/hooks/useAppChat';
import { useOutlookMailContextReader } from './useOutlookMailContext';
import {
  combineUserTextWithEmailBody,
  buildImageDataFromMailAttachments,
  buildFileDataFromMailAttachments
} from '../utilities/buildChatApiMessages';

/**
 * Combines manual upload data with email attachment data.
 * Both manual uploads and email attachments should be included together.
 *
 * @param {Object|Array|null} manualData - Data from manual file upload (single object)
 * @param {Array|null} mailData - Data from email attachments (array)
 * @returns {Object|Array|null} Combined data (single object or array)
 */
function combineUploadData(manualData, mailData) {
  // If both are present, combine them into an array
  if (manualData && mailData) {
    // Ensure manualData is in array format for combination
    const manualArray = Array.isArray(manualData) ? manualData : [manualData];
    return [...manualArray, ...mailData];
  }

  // If only manual data exists, return it as-is
  if (manualData) {
    return manualData;
  }

  // If only mail data exists, return it
  if (mailData) {
    return mailData;
  }

  // Neither exists
  return null;
}

/**
 * Wraps useAppChat with Outlook-specific message enrichment.
 *
 * Intercepts sendMessage to:
 * 1. Read the current Outlook mail context (body + attachments)
 * 2. Combine user text with the email body in apiMessage.content
 * 3. Combine manual uploads with mail attachment images in apiMessage.imageData
 * 4. Combine manual uploads with mail attachment documents in apiMessage.fileData
 *
 * The displayMessage is left unchanged (shows what the user typed in the UI,
 * without the injected email body). Only the apiMessage sent to the server
 * gets the enriched content.
 *
 * @param {Object} options
 * @param {string} options.appId - App ID
 * @param {string} options.chatId - Chat session ID
 * @param {Function} [options.onMessageComplete] - Forwarded to useAppChat
 */
function useOfficeChatAdapter({ appId, chatId, onMessageComplete }) {
  const chat = useAppChat({ appId, chatId, onMessageComplete });
  const readMailContext = useOutlookMailContextReader();

  const sendMessage = useCallback(
    async ({ displayMessage, apiMessage, params, sendChatHistory, messageMetadata }) => {
      let mailCtx = { available: false, bodyText: null, attachments: [] };
      try {
        mailCtx = await readMailContext();
      } catch {
        // Mail context unavailable (e.g. in compose mode without a selected item) — proceed without it
      }

      const enrichedContent = combineUserTextWithEmailBody(apiMessage.content, mailCtx.bodyText);

      // Combine manual uploads with email attachments
      const mailImageData = buildImageDataFromMailAttachments(mailCtx.attachments || []);
      const mailFileData = await buildFileDataFromMailAttachments(mailCtx.attachments || []);

      const combinedImageData = combineUploadData(apiMessage.imageData, mailImageData);
      const combinedFileData = combineUploadData(apiMessage.fileData, mailFileData);

      chat.sendMessage({
        displayMessage,
        apiMessage: {
          ...apiMessage,
          content: enrichedContent,
          imageData: combinedImageData,
          fileData: combinedFileData
        },
        params,
        sendChatHistory,
        messageMetadata
      });
    },
    [chat, readMailContext]
  );

  return { ...chat, sendMessage };
}

export default useOfficeChatAdapter;
