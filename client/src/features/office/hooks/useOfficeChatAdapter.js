import { useCallback } from 'react';
import useAppChat from '../../chat/hooks/useAppChat';
import { useOutlookMailContextReader } from './useOutlookMailContext';
import {
  combineUserTextWithEmailBody,
  buildImageDataFromMailAttachments,
  buildFileDataFromMailAttachments
} from '../utilities/buildChatApiMessages';

/**
 * Wraps useAppChat with Outlook-specific message enrichment.
 *
 * Intercepts sendMessage to:
 * 1. Read the current Outlook mail context (body + attachments)
 * 2. Combine user text with the email body in apiMessage.content
 * 3. Inject mail attachment images into apiMessage.imageData
 * 4. Inject mail attachment documents into apiMessage.fileData
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

      // Only inject mail attachments if the caller didn't provide their own
      const mailImageData = buildImageDataFromMailAttachments(mailCtx.attachments || []);
      const mailFileData = await buildFileDataFromMailAttachments(mailCtx.attachments || []);

      chat.sendMessage({
        displayMessage,
        apiMessage: {
          ...apiMessage,
          content: enrichedContent,
          imageData: apiMessage.imageData ?? mailImageData,
          fileData: apiMessage.fileData ?? mailFileData
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
