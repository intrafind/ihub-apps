// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { INPUT_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import { REVISE_AUTHOR_TEXT_MAX } from '../../../../../../shared/appRevision.js';
import ConversationLog from './ConversationLog';
import { LONG_CONVERSATION_TURNS } from './conversationState';
import { useConversation } from './useConversation';

/**
 * The app builder's conversation, in the editor in place of the form (plan
 * section 3): the log of messages, questions and changes, a status line while
 * a turn runs (with Cancel, also on Escape), and the composer "Tell the
 * builder what to change". Enter sends, Shift+Enter adds a line; the focus
 * stays in the composer.
 *
 * Both editors use it. The page hands it the form, the turn (`refine`, the
 * source's `refineDraft`) and its own save (`persist`), and says who gets a
 * change (`stakes`). The panel makes no request of its own and writes nothing
 * itself.
 *
 * @param {object} props
 * @param {string} props.appId
 * @param {'admin'|'personal'} props.target
 * @param {object|null} props.form - The app as the editor holds it.
 * @param {string} props.language - The content language of the app.
 * @param {(request: object) => Promise<object>} props.refine
 * @param {(next: object) => Promise<{ status: string, value?: object, message?: string|null }>} props.persist
 * @param {Array<{key: string, values?: object}>} [props.stakes] - The stakes line of a change.
 * @param {boolean} [props.testOpen=false] - The test chat is beside the conversation.
 * @param {object|null} [props.saved=null] - The app as it was last loaded or saved. A change
 *   card whose form holds other unsaved edits than its own change says that Apply and Undo
 *   save them too (see `unsavedOutsideChange`).
 * @returns {JSX.Element}
 */
function ConversationPanel({
  appId,
  target,
  form,
  language,
  refine,
  persist,
  stakes = [],
  testOpen = false,
  saved = null
}) {
  const { t } = useTranslation();
  const composerId = useId();
  const hintId = `${composerId}-hint`;
  const [draft, setDraft] = useState('');
  const composerRef = useRef(null);
  const appliedRef = useRef(null);
  const conversation = useConversation({ appId, target, form, language, refine, persist });
  const { working, error, justApplied, entries, turns } = conversation;

  // After Apply (or Undo) the focus goes to the line that says what happened.
  useEffect(() => {
    if (justApplied) appliedRef.current?.focus();
  }, [justApplied]);

  const send = text => {
    if (conversation.send(text)) setDraft('');
    composerRef.current?.focus();
  };

  const onComposerKeyDown = event => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    if (!working) send(draft);
  };

  const onPanelKeyDown = event => {
    if (event.key === 'Escape' && working) {
      event.preventDefault();
      event.stopPropagation();
      conversation.cancel();
    }
  };

  return (
    // The panel only listens for Escape bubbling up from its controls; it is not itself interactive.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      aria-labelledby={`${composerId}-title`}
      onKeyDown={onPanelKeyDown}
      data-testid="conversation-panel"
      className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-xs dark:border-gray-700 dark:bg-gray-800 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id={`${composerId}-title`}
          className="text-lg font-medium text-gray-900 dark:text-gray-100"
        >
          {t('admin.apps.conversation.title')}
        </h2>
        {(entries.length > 0 || turns > 0) && (
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={conversation.startOver}>
            {t('admin.apps.conversation.startOver')}
          </button>
        )}
      </div>

      {turns >= LONG_CONVERSATION_TURNS && (
        <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
          {t('admin.apps.conversation.longHint')}
        </p>
      )}

      <ConversationLog
        entries={entries}
        target={target}
        form={form}
        language={language}
        working={working}
        stakes={stakes}
        testOpen={testOpen}
        saved={saved}
        onSend={send}
        onApply={(id, ticked) => void conversation.apply(id, ticked)}
        onDismiss={conversation.dismiss}
        onUndo={id => void conversation.undo(id)}
        focusId={justApplied?.id ?? null}
        appliedRef={appliedRef}
      />

      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="text-sm text-gray-700 dark:text-gray-300">
          {working ? t('admin.apps.conversation.working') : ''}
        </p>
        {working && (
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={conversation.cancel}>
            {t('admin.apps.conversation.cancel')}
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-red-800 dark:text-red-200"
        >
          <p>{t(error.key, error.values)}</p>
          <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={conversation.retry}>
            {t('admin.apps.conversation.retry')}
          </button>
        </div>
      )}

      <form
        onSubmit={event => {
          event.preventDefault();
          send(draft);
        }}
        className="space-y-2 rounded-lg border-2 border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-800 dark:bg-indigo-900/20"
      >
        <label
          htmlFor={composerId}
          className="block text-sm font-medium text-gray-900 dark:text-gray-100"
        >
          {t('admin.apps.conversation.composer.label')}
        </label>
        <textarea
          id={composerId}
          ref={composerRef}
          rows={3}
          value={draft}
          maxLength={REVISE_AUTHOR_TEXT_MAX}
          placeholder={t('admin.apps.conversation.composer.placeholder')}
          aria-describedby={hintId}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
          className={INPUT_CLASS}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={hintId} className="text-xs text-gray-600 dark:text-gray-400">
            {t('admin.apps.conversation.composer.hint')}
          </p>
          <button
            type="submit"
            className={PRIMARY_BUTTON_CLASS}
            disabled={working || draft.trim() === ''}
          >
            {t('admin.apps.conversation.composer.send')}
          </button>
        </div>
      </form>
    </section>
  );
}

export default ConversationPanel;
