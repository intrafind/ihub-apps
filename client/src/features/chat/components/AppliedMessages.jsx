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
 * The messages of a list this client draws: each with an id and an activity
 * item it knows.
 *
 * @param {Array<Object>|null|undefined} items
 * @returns {Array<{id: string, text: string, step: number|null, activityKind: string}>}
 */
export function shownAppliedMessages(items) {
  return (Array.isArray(items) ? items : []).filter(
    item => item?.id && KNOWN_KINDS.has(item.activityKind)
  );
}

/**
 * The rows of an answer's activity with the messages it read placed among
 * them, each at the step where it was read.
 *
 * The answer reads a message at the start of step `step`, before that step's
 * model call (`AgentLoop`), so every call of that step and of the steps after
 * it already followed the message: it goes before the first row whose `step`
 * is that step or a later one. Rows without a step (a skill, or an activity
 * stored before it kept steps) do not move it; a message no row comes after
 * goes last. Messages of one step keep their order.
 *
 * @param {Array<Object>} items - The activity rows, in order; a row may carry `step`.
 * @param {Array<Object>} applied - The messages read at a step ({@link shownAppliedMessages}).
 * @returns {Array<{type: 'item', item: Object}|{type: 'applied', entry: Object}>}
 */
export function placeAppliedMessages(items, applied) {
  const rows = (Array.isArray(items) ? items : []).map(item => ({ type: 'item', item }));
  for (const entry of Array.isArray(applied) ? applied : []) {
    const at = Number.isInteger(entry.step)
      ? rows.findIndex(
          row =>
            row.type === 'item' && Number.isInteger(row.item.step) && row.item.step >= entry.step
        )
      : -1;
    const row = { type: 'applied', entry };
    if (at === -1) rows.push(row);
    else rows.splice(at, 0, row);
  }
  return rows;
}

/**
 * One message the person sent while iHub was working, as a row of a list:
 * its text and the caption "Sent while iHub was working".
 *
 * @param {Object} props
 * @param {{id: string, text: string}} props.entry
 * @returns {JSX.Element}
 */
export function AppliedMessageRow({ entry }) {
  const { t } = useTranslation();
  return (
    <li data-testid="applied-message" className="flex min-w-0 flex-col items-end py-0.5">
      <span className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-indigo-50 px-3 py-1.5 text-sm text-gray-900 dark:bg-indigo-950/50 dark:text-gray-100">
        {entry.text}
      </span>
      <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
        <Icon name="chat-bubble-left" size="xs" aria-hidden="true" />
        {t('chat.steer.appliedCaption', 'Sent while iHub was working')}
      </span>
    </li>
  );
}

/**
 * AppliedMessages — the messages the person sent while iHub was working on an
 * answer that has no activity rows to place them among (every call of the
 * answer is drawn elsewhere), oldest step first. An answer with activity rows
 * draws them inside its activity list instead, each at its step
 * (`ToolActivity`, {@link placeAppliedMessages}).
 *
 * One component for both moments: a live turn passes what `steer/applied`
 * frames said (`runToMessage.js`), a reopened chat what the store kept
 * (`transformStoredMessages`). Both give `{ id, text, step, activityKind }`, so
 * a message stands in the same place before and after a reload.
 *
 * @param {Object} props
 * @param {Array<{id: string, text: string, step: number|null, activityKind: string|null}>} props.items
 * @returns {JSX.Element|null}
 */
function AppliedMessages({ items }) {
  const { t } = useTranslation();
  const shown = shownAppliedMessages(items);
  if (shown.length === 0) return null;
  return (
    <ul
      aria-label={t('chat.steer.appliedListLabel', 'Messages sent while iHub was working')}
      className="mb-2 flex flex-col gap-1"
    >
      {shown.map(item => (
        <AppliedMessageRow key={item.id} entry={item} />
      ))}
    </ul>
  );
}

export default AppliedMessages;
