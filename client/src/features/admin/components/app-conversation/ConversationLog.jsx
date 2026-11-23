// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import ChangeCard from './ChangeCard';
import QuestionCard from './QuestionCard';
import {
  STARTER_CHIP_KEYS,
  contentChangedSince,
  stillApplied,
  warningKey
} from './conversationState';

const CHIP_CLASS =
  'inline-flex items-center rounded-full border border-gray-300 bg-white px-3 py-1 text-sm text-gray-800 hover:bg-gray-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed';

/** Who wrote an entry, as a visible label. */
function Speaker({ who }) {
  const { t } = useTranslation();
  return (
    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
      {who === 'author' ? t('admin.apps.conversation.you') : t('admin.apps.conversation.builder')}
    </p>
  );
}

/**
 * The entries of the conversation as a log (`role="log"`, announced politely
 * as entries arrive): the builder's fixed first message with suggestion chips,
 * then each message, question and change.
 *
 * Only the newest entry has controls, and only while no turn runs ("older
 * cards lose their buttons"). The one exception is Undo, which stays on the
 * newest applied change.
 *
 * @param {object} props
 * @param {import('./useConversation').ConversationEntry[]} props.entries
 * @param {'admin'|'personal'} props.target
 * @param {object|null} props.form
 * @param {string} props.language
 * @param {boolean} props.working - A turn is running.
 * @param {Array<{key: string, values?: object}>} [props.stakes]
 * @param {boolean} [props.testOpen]
 * @param {(text: string) => void} props.onSend - Sends an author message.
 * @param {(id: number, ticked: object) => void} props.onApply
 * @param {(id: number) => void} props.onDismiss
 * @param {(id: number) => void} props.onUndo
 * @param {number|null} [props.focusId] - The change whose "Applied" line takes the focus.
 * @param {{ current: HTMLElement|null }} [props.appliedRef]
 * @returns {JSX.Element}
 */
function ConversationLog({
  entries,
  target,
  form,
  language,
  working,
  stakes,
  testOpen,
  onSend,
  onApply,
  onDismiss,
  onUndo,
  focusId = null,
  appliedRef
}) {
  const { t } = useTranslation();
  const newest = entries[entries.length - 1];

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label={t('admin.apps.conversation.logLabel')}
      className="space-y-4"
    >
      <div>
        <Speaker who="builder" />
        <p className="text-sm text-gray-900 dark:text-gray-100">
          {t('admin.apps.conversation.intro')}
        </p>
        {entries.length === 0 && (
          <ul
            className="mt-2 flex flex-wrap gap-2"
            aria-label={t('admin.apps.conversation.chips.label')}
          >
            {STARTER_CHIP_KEYS.map(key => (
              <li key={key}>
                <button
                  type="button"
                  className={CHIP_CLASS}
                  disabled={working}
                  onClick={() => onSend(t(key))}
                >
                  {t(key)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {entries.map(entry => {
        const interactive = entry === newest && !working;
        if (entry.role === 'author') {
          return (
            <div key={entry.id} className="ml-6 rounded-lg bg-indigo-50 p-3 dark:bg-indigo-900/30">
              <Speaker who="author" />
              <p className="whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100">
                {entry.text}
              </p>
            </div>
          );
        }
        return (
          <div key={entry.id}>
            <Speaker who="builder" />
            {entry.text && (entry.kind !== 'question' || entry.text !== entry.question?.text) && (
              <p className="mb-2 whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-gray-100">
                {entry.text}
              </p>
            )}
            {entry.kind === 'message' && entry.warnings?.length > 0 && (
              <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
                {[...new Set(entry.warnings.map(warningKey))].map(key => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            )}
            {entry.kind === 'question' && (
              <QuestionCard
                question={entry.question}
                interactive={interactive}
                onAnswer={onSend}
                onSkip={() => onSend(t('admin.apps.conversation.question.skipped'))}
              />
            )}
            {entry.kind === 'change' && (
              <ChangeCard
                entry={entry}
                target={target}
                form={form}
                language={language}
                interactive={interactive}
                stale={contentChangedSince(form, entry.baseSnapshot, target)}
                undoAvailable={stillApplied(form, entry.applied)}
                stakes={stakes}
                testOpen={testOpen}
                onApply={ticked => onApply(entry.id, ticked)}
                onDismiss={() => onDismiss(entry.id)}
                onUndo={() => onUndo(entry.id)}
                appliedRef={entry.id === focusId ? appliedRef : undefined}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default ConversationLog;
