import { useCallback } from 'react';
import useAppChat from '../../chat/hooks/useAppChat';
import { useEmbeddedHost, applyHostContextFlags } from '../contexts/EmbeddedHostContext';
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
  const host = useEmbeddedHost();

  const sendMessage = useCallback(
    async ({ displayMessage, apiMessage, params, sendChatHistory, messageMetadata }) => {
      // The host adapter returns either the current Outlook mail item
      // (in the taskpane) or the active browser tab's text + selection
      // (in the extension's side panel). Both shapes share
      // { bodyText, attachments } so the rest of this function is
      // host-agnostic.
      let ctx = { available: false, bodyText: null, attachments: [] };
      try {
        ctx = await host.readMessageContext();
      } catch {
        // Context unavailable (compose mode without a selected item,
        // chrome:// page, etc.) — proceed without it.
      }

      // Apply the user's per-message opt-out flags from the chat input's
      // `+` menu. `applyHostContextFlags` clears `bodyText` / `attachments`
      // for every toggle the host adapter declared whose flag is `false`.
      // No-op when the host has no toggles or the user hasn't touched any.
      ctx = applyHostContextFlags(ctx, host.contextToggles, params?.hostContextFlags);

      const enrichedContent = combineUserTextWithEmailBody(apiMessage.content, ctx.bodyText);

      // Combine manual uploads with attachments harvested from the host
      // (email attachments in Outlook, none today in the extension; this
      // path stays untouched because attachments is just an empty array).
      const hostImageData = buildImageDataFromMailAttachments(ctx.attachments || []);
      const hostFileData = await buildFileDataFromMailAttachments(ctx.attachments || []);

      const combinedImageData = combineUploadData(apiMessage.imageData, hostImageData);
      const combinedFileData = combineUploadData(apiMessage.fileData, hostFileData);

      // hostContextFlags is a client-only opt-out signal — strip it before
      // forwarding so it doesn't show up in the outgoing chat-completion
      // request body.
      // eslint-disable-next-line no-unused-vars
      const { hostContextFlags: _hostContextFlags, ...paramsForServer } = params || {};

      chat.sendMessage({
        displayMessage,
        apiMessage: {
          ...apiMessage,
          content: enrichedContent,
          imageData: combinedImageData,
          fileData: combinedFileData
        },
        params: paramsForServer,
        sendChatHistory,
        messageMetadata
      });
    },
    [chat, host]
  );

  return { ...chat, sendMessage };
}

export default useOfficeChatAdapter;
