// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useConnectResult } from './useConnectResult';
import { markRetried, pendingRetry } from './connectRetry';

/**
 * After a successful connect from a chat's Connect card, ask the assistant
 * once to retry the request that needed the connection (see
 * `connectRetry.js` for when it does and does not).
 *
 * The retry is an ordinary typed follow-up message ("I connected Jira.
 * Please try again."), so the user sees it, it is stored with the chat, and
 * the model re-issues the call with the connection now in place.
 *
 * It waits until the chat can take a message (`ready`, not `busy`), makes
 * one attempt per page, and records the answer as retried only when the
 * chat took the message (`send` resolved true), so a message the chat turned
 * away is not counted as the one retry.
 *
 * @param {Object} params
 * @param {string|null} params.chatId - The chat on screen
 * @param {Array<Object>} params.messages - Its messages
 * @param {boolean} params.ready - The transcript is loaded (not hydrating)
 * @param {boolean} params.busy - The chat cannot take a message now (a turn
 *   running, an attachment processing, audio recording or transcribing)
 * @param {(text: string) => boolean|Promise<boolean>} params.send - Send a typed
 *   user message in this chat; resolves whether the chat took it
 *
 * @example
 * useConnectRetry({ chatId, messages, ready: !hydrating, busy: processing,
 *   send: text => sendTypedTurn(text) });
 */
export function useConnectRetry({ chatId, messages, ready, busy, send }) {
  const { t } = useTranslation();
  const connected = useConnectResult(result => result.connected);
  const doneRef = useRef(false);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });

  useEffect(() => {
    if (doneRef.current || !connected || !ready || busy || !chatId) return;
    if (!Array.isArray(messages) || messages.length === 0) return;
    // One attempt per page: a chat that turns the message away says why
    // (a required variable, say) and is not asked again on every render.
    doneRef.current = true;
    const target = pendingRetry({ connected, chatId, messages });
    if (!target) return;
    const text = t('integrations.connect.retryMessage', 'I connected {{name}}. Please try again.', {
      name: target.prompt.name
    });
    Promise.resolve(sendRef.current(text)).then(
      sent => {
        if (sent) markRetried(target.key);
      },
      () => {
        /* not sent: not counted as the retry */
      }
    );
  }, [connected, ready, busy, chatId, messages, t]);
}

export default useConnectRetry;
