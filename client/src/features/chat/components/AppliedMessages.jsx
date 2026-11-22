// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * The activity items this client knows how to draw for a message the answer
 * read at a step. The server names the item (`activityKind`, from
 * `server/utils/toolDisplay.js`); an item it names that this client does not
 * know is not drawn, rather than guessed.
 */
const KNOWN_KINDS = new Set(['user_message']);

/**
 * AppliedMessages — the messages the person sent while iHub was working on an
 * answer and that the answer read at one of its steps, drawn inside that
 * answer, oldest step first, each with the caption "Sent while iHub was
 * working".
 *
 * One component for both moments: a live turn passes what `steer/applied`
 * frames said (`runToMessage.js`), a reopened chat what the store kept
 * (`transformStoredMessages`). Both give `{ id, text, step, activityKind }`, so
 * a message stands in the same place before and after a reload: below the
 * activity of the answer, above its text.
 *
 * @param {Object} props
 * @param {Array<{id: string, text: string, step: number|null, activityKind: string|null}>} props.items
 * @returns {JSX.Element|null}
 */
function AppliedMessages({ items }) {
  const { t } = useTranslation();
  const shown = (Array.isArray(items) ? items : []).filter(
    item => item?.id && KNOWN_KINDS.has(item.activityKind)
  );
  if (shown.length === 0) return null;
  const caption = t('chat.steer.appliedCaption', 'Sent while iHub was working');
  return (
    <ul
      aria-label={t('chat.steer.appliedListLabel', 'Messages sent while iHub was working')}
      className="mb-2 flex flex-col items-end gap-1.5"
    >
      {shown.map(item => (
        <li
          key={item.id}
          data-testid="applied-message"
          className="flex max-w-[85%] min-w-0 flex-col items-end"
        >
          <span className="max-w-full whitespace-pre-wrap break-words rounded-lg bg-indigo-50 px-3 py-1.5 text-sm text-gray-900 dark:bg-indigo-950/50 dark:text-gray-100">
            {item.text}
          </span>
          <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
            <Icon name="chat-bubble-left" size="xs" aria-hidden="true" />
            {caption}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default AppliedMessages;
