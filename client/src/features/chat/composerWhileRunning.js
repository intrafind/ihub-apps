// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the chat page hands its composer for a message while iHub is working
 * (#3191, `ChatInput`'s `whileRunning`), or null when it offers nothing and the
 * composer keeps its single Send/Stop button.
 *
 * Offered only with the feature `steering` on and where the server says this
 * person may send into the chat's running answer (`maySteer === true` of
 * `GET /api/chats/:chatId`; absent means the feature is off and reads as false),
 * not in a comparison and not while a recording is transcribed.
 *
 * @param {Object} params
 * @param {boolean} params.steeringEnabled - The feature `steering`.
 * @param {boolean|null|undefined} params.maySteer - The server's word for this person.
 * @param {boolean} params.compareModeActive
 * @param {boolean} params.isTranscribing
 * @param {string|null} params.runningRunId - The turn's run once it started.
 * @param {boolean} params.clarificationPending - A question or an approval waits above.
 * @param {boolean} params.full - 20 messages wait.
 * @param {(text: string) => void} params.onSteer
 * @param {(text: string) => void} params.onSendAfter
 * @returns {{enabled: true, ready: boolean, blockedReason: string|null, full: boolean,
 *   onSteer: Function, onSendAfter: Function}|null}
 */
export function composerWhileRunning({
  steeringEnabled,
  maySteer,
  compareModeActive,
  isTranscribing,
  runningRunId,
  clarificationPending,
  full,
  onSteer,
  onSendAfter
}) {
  if (steeringEnabled !== true || maySteer !== true || compareModeActive || isTranscribing) {
    return null;
  }
  return {
    enabled: true,
    // Until the turn's run has started there is nothing to send into.
    ready: Boolean(runningRunId),
    blockedReason: clarificationPending ? 'question' : null,
    full: full === true,
    onSteer,
    onSendAfter
  };
}

/**
 * The composer's text after "Copy to input" of a message that was not
 * delivered: the message is added below what is typed, never in its place.
 *
 * @param {string} current - What the composer holds.
 * @param {string} text - The message's text.
 * @returns {string}
 */
export function withCopiedText(current, text) {
  return current ? `${current}\n${text}` : text;
}
