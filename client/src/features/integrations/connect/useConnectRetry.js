// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { consumeConnectResult } from './connectResult';
import { claimRetry } from './connectRetry';

/**
 * After a successful connect from a chat's Connect card, ask the assistant
 * once to retry the request that needed the connection (see
 * `connectRetry.js` for when it does and does not).
 *
 * The retry is an ordinary follow-up message ("I connected Jira. Please try
 * again."), so the user sees it, it is stored with the chat, and the model
 * re-issues the call with the connection now in place.
 *
 * @param {Object} params
 * @param {string|null} params.chatId - The chat on screen
 * @param {Array<Object>} params.messages - Its messages
 * @param {boolean} params.ready - The transcript is loaded (not hydrating)
 * @param {boolean} params.busy - A turn is running
 * @param {(text: string) => void} params.send - Send a user message in this chat
 *
 * @example
 * useConnectRetry({ chatId, messages, ready: !hydrating, busy: processing,
 *   send: text => sendTypedTurn(text) });
 */
export function useConnectRetry({ chatId, messages, ready, busy, send }) {
  const { t } = useTranslation();
  const [connected] = useState(() => consumeConnectResult().connected);
  const doneRef = useRef(false);
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (doneRef.current || !connected || !ready || busy || !chatId) return;
    if (!Array.isArray(messages) || messages.length === 0) return;
    doneRef.current = true;
    const target = claimRetry({ connected, chatId, messages });
    if (!target) return;
    sendRef.current(
      t('integrations.connect.retryMessage', 'I connected {{name}}. Please try again.', {
        name: target.prompt.name
      })
    );
  }, [connected, ready, busy, chatId, messages, t]);
}

export default useConnectRetry;
