import { useEffect, useRef, useState } from 'react';
import { fetchChat } from '../../../api';
import { invalidateChatsCache } from '../../../shared/hooks/chatListStore';

/**
 * Put a stored chat back on screen in the task pane.
 *
 * A server-backed chat keeps no browser copy, so this fetch is the only thing
 * that shows its transcript — when the pane opens a chat from the history, and
 * when "Restore previous chat" brings back the one the last email set aside.
 * The same job `AppChat` does for `/apps/:appId/c/:chatId`, cut down to what the
 * pane needs:
 *
 * - A chat the pane minted and has not sent yet is not in the store, so it is
 *   not asked for — that would only buy a 404 and a spinner where the greeting
 *   belongs. The caller says which chat that is with `isFreshChat`.
 * - A turn that is still generating — the run outlives the pane that started
 *   it, or was started in the browser — is re-attached to: the ledger is
 *   replayed and the live stream followed, then the transcript is re-read once
 *   the turn settles, because the store is what the answer finally was.
 * - The settings the chat was last answered with (model, tools, websearch, …)
 *   are handed back for `useAppSettings`, so a reopened chat keeps its setup.
 *
 * Also keeps the shared chat list fresh: opening a chat clears its unseen flag
 * server-side, and a finished turn moves a chat to the top of the list.
 *
 * @param {Object} options
 * @param {Object} options.chat - What `useAppChat` returned for this chat.
 * @param {string} options.chatId - The chat on screen.
 * @param {boolean} options.serverBacked - Whether the chat is stored server-side.
 * @param {boolean} options.isFreshChat - Whether the pane minted this chat and
 *   has not sent anything in it yet.
 * @returns {Object|null} The stored chat's settings, or null for a new chat.
 */
export default function useStoredChatHydration({ chat, chatId, serverBacked, isFreshChat }) {
  const { messages, processing, finishHydration, loadServerMessages, reattachToRun } = chat;
  const [chatSettings, setChatSettings] = useState(null);

  // A different chat drops the previous chat's setup straight away; the app's
  // defaults apply until the new one's document arrives.
  useEffect(() => {
    setChatSettings(null);
  }, [chatId]);

  // The chat the last hydration attempt was for, and whether its fetch is
  // still out. A re-render must neither fetch again nor end a pending
  // hydration behind its back.
  const attemptRef = useRef(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!serverBacked || !chatId) return;
    if (attemptRef.current === chatId) {
      // Already fetched (or deliberately not). Nothing else clears the
      // loading flag after a chat switch lands back here, so say so.
      if (!pendingRef.current) finishHydration();
      return;
    }
    // The chat being left is still on screen for the render that switched
    // away from it; the switch clears it, and this effect runs again then.
    if (messages.length > 0) return;
    attemptRef.current = chatId;
    if (isFreshChat) {
      pendingRef.current = false;
      finishHydration();
      return;
    }
    pendingRef.current = true;

    const owns = () => attemptRef.current === chatId;
    (async () => {
      try {
        const result = await fetchChat(chatId);
        if (!owns()) return;
        const storedMessages = Array.isArray(result?.messages) ? result.messages : [];
        loadServerMessages(storedMessages, { preserveLocal: true });
        // `modelId` lives on the chat document rather than in `settings`.
        const stored = result?.chat?.settings;
        const storedModelId = result?.chat?.modelId;
        setChatSettings(
          stored || storedModelId
            ? { ...(stored || {}), ...(storedModelId ? { modelId: storedModelId } : {}) }
            : null
        );
        invalidateChatsCache();

        // Re-attach only when the answer is not stored yet. The server stores
        // the answer before it releases the run, so a `running` chat can
        // already hold it — attaching then would replay it into a second bubble.
        const activeRunId =
          result?.chat?.status === 'running' ? result.chat.activeRunId || null : null;
        const answered =
          activeRunId !== null &&
          storedMessages.some(
            message => message.role === 'assistant' && message.runId === activeRunId
          );
        if (activeRunId && !answered) {
          reattachToRun(activeRunId, {
            onSettled: async () => {
              if (!owns()) return;
              try {
                const settled = await fetchChat(chatId);
                if (!owns()) return;
                loadServerMessages(Array.isArray(settled?.messages) ? settled.messages : []);
                invalidateChatsCache();
              } catch (err) {
                // The live projection stays on screen; it is very probably right.
                console.warn('Could not re-read the settled chat:', err.message);
              }
            }
          });
        }
      } catch (err) {
        if (!owns()) return;
        // A chat set aside before its first message never reached the store.
        if (err?.status !== 404) {
          console.warn('Failed to load the stored chat, starting empty:', err.message);
        }
        finishHydration();
      } finally {
        if (owns()) pendingRef.current = false;
      }
    })();
    // `reattachToRun` changes with the chat id, which is already a dependency;
    // listing it would only re-run the guard above.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [serverBacked, chatId, isFreshChat, messages.length, loadServerMessages, finishHydration]);

  // A finished turn changes the list: a new chat appears in it, an existing one
  // moves to the top and may have gained a title. A failed turn is stored too.
  const wasProcessingRef = useRef(false);
  useEffect(() => {
    const wasProcessing = wasProcessingRef.current;
    wasProcessingRef.current = processing;
    if (serverBacked && wasProcessing && !processing) invalidateChatsCache();
  }, [processing, serverBacked]);

  return chatSettings;
}
