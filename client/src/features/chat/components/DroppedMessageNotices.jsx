// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/** Characters of a message's text shown in its notice and in the name of its buttons. */
const EXCERPT_CHARS = 80;

/** A short form of a text. */
function excerpt(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

/**
 * Why a message was not delivered, by the reason the server named
 * (`steer/dropped.reason`, `STEER_DROP_REASONS` in shared/runEvents.js). One
 * static `t()` call per reason, so the check of the translation keys sees them;
 * a reason this client does not know gets the general text.
 *
 * @param {Function} t
 * @param {string|null} reason
 * @returns {string}
 */
export function droppedReasonText(t, reason) {
  switch (reason) {
    case 'expired':
      return t('chat.steer.dropped.expired', 'iHub did not read it in time.');
    case 'queue_full':
      return t('chat.steer.dropped.queueFull', 'Too many messages were waiting.');
    case 'run_paused':
      return t('chat.steer.dropped.runPaused', 'The answer stopped to ask you something first.');
    case 'run_stopped':
      return t('chat.steer.dropped.runStopped', 'The answer was stopped.');
    case 'run_failed':
      return t('chat.steer.dropped.runFailed', 'The answer ended with an error.');
    case 'superseded':
      return t('chat.steer.dropped.superseded', 'A newer message replaced the answer.');
    case 'temporary_chat':
      return t(
        'chat.steer.dropped.temporaryChat',
        'In a temporary chat, iHub does not send a next message on its own.'
      );
    case 'not_started':
      return t('chat.steer.dropped.notStarted', 'The next message could not be started.');
    default:
      return t('chat.steer.dropped.ended', 'The answer ended before iHub read it.');
  }
}

/**
 * DroppedMessageNotices — the messages the person sent into a running answer
 * that will never be read (`steer/dropped`), each with its text, the reason the
 * server named, "Copy to input" (the text goes back into the composer) and a
 * close button. Nothing is silently gone: a notice stays until the person
 * closes it or copies the text.
 *
 * @param {Object} props
 * @param {Array<{id: string, text: string, reason: string|null}>} props.items
 * @param {(item: Object) => void} props.onCopy - Put the text into the composer.
 * @param {(id: string) => void} props.onDismiss
 * @returns {JSX.Element|null}
 */
function DroppedMessageNotices({ items, onCopy, onDismiss }) {
  const { t } = useTranslation();
  const list = Array.isArray(items) ? items.filter(item => item?.id) : [];
  if (list.length === 0) return null;
  return (
    <ul
      aria-label={t('chat.steer.droppedListLabel', 'Messages not delivered')}
      className="mx-2 mt-2 flex min-w-0 flex-col gap-1"
    >
      {list.map(item => {
        const short = excerpt(item.text);
        return (
          <li
            key={item.id}
            data-testid="dropped-message"
            className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
          >
            <Icon name="exclamationTriangle" size="xs" className="mt-0.5 flex-none" />
            <span className="min-w-0 flex-1 break-words">
              <span className="font-medium">{t('chat.steer.notDelivered', 'Not delivered')}: </span>
              {short} <span>{droppedReasonText(t, item.reason)}</span>
            </span>
            <span className="flex flex-none items-center gap-1">
              <button
                type="button"
                onClick={() => onCopy?.(item)}
                aria-label={t('chat.steer.copyToInputNamed', 'Copy to input: {{text}}', {
                  text: short
                })}
                className="inline-flex min-h-6 items-center rounded px-1.5 font-medium text-amber-900 underline hover:bg-amber-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-amber-100 dark:hover:bg-amber-900/50"
              >
                {t('chat.steer.copyToInput', 'Copy to input')}
              </button>
              <button
                type="button"
                onClick={() => onDismiss?.(item.id)}
                aria-label={t('chat.steer.dismissNamed', 'Close notice: {{text}}', {
                  text: short
                })}
                title={t('common.close', 'Close')}
                className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-amber-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-amber-900/50"
              >
                <Icon name="x" size="xs" />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default DroppedMessageNotices;
