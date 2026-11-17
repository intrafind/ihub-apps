// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useConnectResult } from './useConnectResult';
import { getConnectResumeStatus, setConnectResumeStatus } from './connectResumeStatus';

/**
 * After a successful connect from a chat's Connect card, ask the server to
 * continue the call that waited for the connection (#3752).
 *
 * The server keeps the call (`pendingConnect` on the chat: its tool and its
 * arguments) and runs it once through the usual checks; this hook only says
 * "continue this one" with the record's id. It sends no message the user did
 * not write, no tool and no arguments. The browser comes back to the same
 * chat with `integration_connected=<id>`; the hook acts only when the chat's
 * pending record is for that integration, so a connect from Settings, a
 * reload or a chat without a record does nothing.
 *
 * It waits until the chat can take a turn (`ready`, not `busy`), makes one
 * attempt per page, and the server's take-once rule is the guard against a
 * second run (a second tab, a reload before the URL was cleaned).
 *
 * @param {Object} params
 * @param {string|null} params.chatId - The chat on screen
 * @param {{id: string, integrations: string[]}|null} params.pendingConnect - The
 *   record the stored chat reports (`chat.pendingConnect`), null for none
 * @param {boolean} params.ready - The transcript, model, scopes and settings are loaded
 * @param {boolean} params.busy - A turn runs or an attachment is processing
 * @param {(request: {id: string, integration: string}) => boolean|Promise<boolean>} params.resume -
 *   Send the continuation; resolves whether the chat took it
 *
 * @example
 * useConnectResume({ chatId, pendingConnect, ready, busy,
 *   resume: request => submitConnectResume(request) });
 */
export function useConnectResume({ chatId, pendingConnect, ready, busy, resume }) {
  const connected = useConnectResult(result => result.connected);
  const doneRef = useRef(false);
  // The chat the page came back to: a later switch to another chat must not
  // run that chat's record for the same integration.
  const returnChatRef = useRef(null);
  const resumeRef = useRef(resume);
  useEffect(() => {
    resumeRef.current = resume;
  });

  useEffect(() => {
    if (chatId && !returnChatRef.current) returnChatRef.current = chatId;
    if (chatId && returnChatRef.current !== chatId && connected) {
      // Another chat is on screen: this page's outcome does not belong to it.
      doneRef.current = true;
      setConnectResumeStatus(connected, null);
    }
    if (doneRef.current || !connected || !ready || busy || !chatId) return;
    // Hydration has not reported the record yet, or there is none.
    if (!pendingConnect?.id || !pendingConnect.integrations?.includes(connected)) return;
    // One attempt per page.
    doneRef.current = true;
    setConnectResumeStatus(connected, { state: 'resuming' });
    Promise.resolve(resumeRef.current({ id: pendingConnect.id, integration: connected })).then(
      sent => {
        if (!sent) setConnectResumeStatus(connected, null);
      },
      () => setConnectResumeStatus(connected, null)
    );
  }, [connected, ready, busy, chatId, pendingConnect]);

  // The turn ended: the card shows the plain "connected" line again.
  const sawBusyRef = useRef(false);
  useEffect(() => {
    if (!connected || getConnectResumeStatus(connected)?.state !== 'resuming') return;
    if (busy) sawBusyRef.current = true;
    else if (sawBusyRef.current) setConnectResumeStatus(connected, { state: 'done' });
  }, [busy, connected]);
}

export default useConnectResume;
