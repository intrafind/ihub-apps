import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchChat, fetchPlatformConfig, importChat } from '../../../api';
import { openExternalUrl } from '../../../utils/externalNavigation';
import {
  buildImportMessages,
  buildWebChatUrl,
  classifyImportError
} from '../utilities/officeWebHandoff';

/**
 * "Open in web": continue the pane's conversation in the web app.
 *
 * The pane's chats live only in the pane, so opening one in the browser means
 * storing a copy as a durable chat and opening its URL — something the user
 * asks for, never something that happens as they type. Available only where
 * the installation stores chats at all (`chats.persistence`); the entry is
 * simply not offered elsewhere, rather than offered and refused.
 *
 * Asking again for a conversation that has not changed opens the copy already
 * made instead of adding another to the user's history.
 *
 * @param {Object} params
 * @param {string} params.baseUrl - Public base URL of the deployment.
 * @param {string} [params.appId] - App the conversation is held with.
 * @param {string} params.chatId - The pane's own id for this conversation.
 * @param {Array<Object>} params.messages - The pane's chat messages.
 * @param {string} [params.modelId] - Model the conversation last used.
 * @param {boolean} params.processing - Whether an answer is still streaming.
 * @returns {{
 *   available: boolean,
 *   canOpen: boolean,
 *   opening: boolean,
 *   notice: { tone: 'error'|'info', message: string }|null,
 *   dismissNotice: () => void,
 *   open: () => Promise<void>
 * }}
 */
export default function useOpenChatInWeb({
  baseUrl,
  appId,
  chatId,
  messages,
  modelId,
  processing
}) {
  const { t } = useTranslation();
  const [available, setAvailable] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState(null);
  // The last import: which of the pane's conversations it was, what it held,
  // and the web chat it became.
  const lastImportRef = useRef(null);
  const openingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchPlatformConfig()
      .then(config => {
        if (!cancelled) setAvailable(config?.chats?.persistence === true);
      })
      .catch(() => {
        // Not knowing is the same as "no": the entry stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const importable = useMemo(() => buildImportMessages(messages), [messages]);
  const canOpen = available && !!appId && importable.length > 0 && !processing && !opening;

  const dismissNotice = useCallback(() => setNotice(null), []);

  const open = useCallback(async () => {
    if (openingRef.current || !appId || importable.length === 0) return;
    openingRef.current = true;
    setOpening(true);
    setNotice(null);
    try {
      const signature = JSON.stringify([appId, importable]);
      let webChatId = null;
      const last = lastImportRef.current;
      if (last && last.chatId === chatId && last.signature === signature) {
        try {
          // The copy may have been deleted since: only reuse one that is there.
          await fetchChat(last.webChatId);
          webChatId = last.webChatId;
        } catch {
          // Gone, or unreachable — import again below.
        }
      }
      if (!webChatId) {
        const { chat } = await importChat({ appId, modelId, messages: importable });
        webChatId = chat.id;
        lastImportRef.current = { chatId, signature, webChatId };
      }
      const url = buildWebChatUrl(baseUrl, appId, webChatId);
      if (!openExternalUrl(url)) {
        setNotice({
          tone: 'error',
          message: t(
            'office.openInWeb.blocked',
            'The browser could not be opened. Open this address yourself: {{url}}',
            { url }
          )
        });
      }
    } catch (error) {
      const errorMessages = {
        unavailable: t(
          'office.openInWeb.unavailable',
          'This iHub does not store chats, so the conversation cannot be opened in the web app.'
        ),
        denied: t('office.openInWeb.denied', 'You do not have access to this app in the web app.'),
        tooLong: t(
          'office.openInWeb.tooLong',
          'This conversation is too long to open in the web app. Start a new chat and try again.'
        ),
        failed: t(
          'office.openInWeb.failed',
          'The conversation could not be opened in the web app. Try again.'
        )
      };
      console.error('Open in web failed:', error);
      setNotice({ tone: 'error', message: errorMessages[classifyImportError(error)] });
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, [appId, baseUrl, chatId, importable, modelId, t]);

  return { available, canOpen, opening, notice, dismissNotice, open };
}
