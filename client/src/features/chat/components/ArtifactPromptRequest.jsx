// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The question an HTML artifact asked to send to the chat (its `sendPrompt`),
 * shown for the user to confirm. Nothing is sent without the click: the
 * artifact is model-written markup, and a script in it could ask on its own.
 *
 * @param {Object} props
 * @param {string} props.text - The question, as the artifact posted it (already cleaned).
 * @param {boolean} props.busy - A turn is running: the question cannot be sent yet.
 * @param {() => void} props.onSend
 * @param {() => void} props.onCancel
 */
export default function ArtifactPromptRequest({ text, busy, onSend, onCancel }) {
  const { t } = useTranslation();
  const sendRef = useRef(null);
  const cancelRef = useRef(null);
  // Esc on either button drops the question (and does not close the pane behind it).
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
    }
  };

  // The request comes from a click inside the frame: move the focus to the
  // decision, so keyboard and screen-reader users land on it.
  // A disabled Send cannot take the focus: Cancel takes it then.
  useEffect(() => {
    (busy ? cancelRef : sendRef).current?.focus();
    // Only when a question arrives, not each time a turn starts or ends.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [text]);

  return (
    <fieldset
      data-testid="artifact-prompt-request"
      className="m-0 min-w-0 flex-none border-0 border-b border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 px-3 py-2 text-sm"
    >
      <legend className="float-left w-full p-0 text-xs font-medium text-indigo-900 dark:text-indigo-200">
        {t('chatArtifacts.promptRequest', 'The artifact wants to ask in the chat:')}
      </legend>
      <p
        className="clear-left mt-1 line-clamp-4 whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100"
        title={text}
      >
        {text}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          ref={sendRef}
          type="button"
          onClick={onSend}
          onKeyDown={onKeyDown}
          disabled={busy}
          className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('chatArtifacts.promptSend', 'Send')}
        </button>
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          onKeyDown={onKeyDown}
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('common.cancel', 'Cancel')}
        </button>
        {busy && (
          <output className="text-xs text-gray-600 dark:text-gray-300">
            {t(
              'chatArtifacts.promptBusy',
              'An answer is still being written. Send once it is done.'
            )}
          </output>
        )}
      </div>
    </fieldset>
  );
}
