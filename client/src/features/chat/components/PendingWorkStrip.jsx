// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { COMPOSER_SELECTOR } from '../../../shared/utils/focusPolicy';

/** Rows shown before the rest fold behind "N pending · Show all". */
export const PENDING_MAX_ROWS = 2;

/** Characters of an item's text used in the name of its buttons. */
const NAME_EXCERPT_CHARS = 60;

/** Icon per kind the server names; anything else gets the message icon. */
const KIND_ICONS = { steer: 'chat-bubble-left', send_after: 'clock' };

/**
 * The text before an item's own text. The server names the key (`labelKey`);
 * the known keys are spelled out so the check of the translation keys sees
 * them. A key this client does not know yet is still looked up, and shows
 * nothing when it has no text.
 *
 * @param {Function} t
 * @param {string|undefined} labelKey - The item's `labelKey`; an item may come without one.
 * @param {{exists?: (key: string) => boolean}} [i18n] - Tells whether an unknown key has a text.
 * @returns {string}
 */
export function pendingLabel(t, labelKey, i18n) {
  switch (labelKey) {
    case 'chat.pending.steer':
      return t('chat.pending.steer', 'Will be read at the next step');
    case 'chat.pending.sendAfter':
      return t('chat.pending.sendAfter', 'Will be sent as the next message');
    default:
      return typeof labelKey === 'string' && labelKey && i18n?.exists?.(labelKey)
        ? t(labelKey)
        : '';
  }
}

/** A short form of a text for a button name. */
function excerpt(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > NAME_EXCERPT_CHARS ? `${flat.slice(0, NAME_EXCERPT_CHARS - 1)}…` : flat;
}

/** The ids of a list, in order: two lists with the same ids are the same list. */
function idsOf(list) {
  return list.map(item => item.id).join('\n');
}

/** The composer's first control that takes the focus, where a removal of the last item sends it. */
function composerTarget() {
  const composer = document.querySelector(COMPOSER_SELECTOR);
  return (
    composer?.querySelector(
      'textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), [contenteditable="true"], button:not([disabled])'
    ) || null
  );
}

/**
 * Where the focus goes once the item the person removed has left the list: the
 * row now at its place (or the last row), its last button; with no row left,
 * the composer.
 */
function restoreTarget(root, index) {
  if (!root) return composerTarget();
  const rows = root.querySelectorAll('[data-testid="pending-item"]');
  const row = rows[Math.min(index, rows.length - 1)];
  const buttons = row ? row.querySelectorAll('button') : [];
  return buttons[buttons.length - 1] || root.querySelector('button[aria-controls]');
}

/**
 * The button of one action the server offers on an item; null for an action
 * this client does not know (it cannot offer what it cannot name).
 */
function ActionButton({ action, item, onAction, t }) {
  if (action !== 'remove') return null;
  const name = t('chat.pending.remove', 'Remove message: {{text}}', { text: excerpt(item.text) });
  return (
    <button
      type="button"
      onClick={() => onAction?.(action, item)}
      aria-label={name}
      title={name}
      className="inline-flex h-6 w-6 flex-none items-center justify-center rounded text-gray-600 hover:bg-white focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-300 dark:hover:bg-gray-800"
    >
      <Icon name="x" size="xs" />
    </button>
  );
}

/**
 * PendingWorkStrip — what waits in a chat, as the server lists it: messages
 * the running answer will read at its next step, messages that will be sent as
 * the next message.
 *
 * A pure function of the server's `pending[]` (`GET /api/chats/:chatId`, see
 * docs/chat-persistence.md): the label comes from the item's `labelKey`, the
 * buttons from its `actions`; nothing is worked out from an id. An item is a
 * row with a text button (shows the whole text, or folds it to one line again)
 * and a separate 24 px button per action, named with the item's text ("Remove
 * message: use the 2025 numbers"). After {@link PENDING_MAX_ROWS} rows the rest
 * fold behind a disclosure button ("3 pending · Show all"); `collapsed` (for a
 * narrow embed) starts with the disclosure alone. When an item the person
 * removed is gone from the list, the focus moves to the next item's button (or,
 * when it was the last item, to the composer), so the keyboard does not fall
 * back to the top of the page. A list that changes and still holds the item
 * means the removal did not happen: the focus is then left alone, then and
 * later.
 *
 * @param {Object} props
 * @param {Array<{id: string, kind?: string, labelKey?: string, text?: string, actions?: string[]}>} props.items
 *   The server's `pending[]`, oldest first.
 * @param {(action: string, item: Object) => void} [props.onAction] - An action button was pressed.
 * @param {number} [props.maxRows] - Rows before the rest fold.
 * @param {boolean} [props.collapsed=false] - Start folded, also with few items.
 * @param {string} [props.className]
 * @returns {JSX.Element|null}
 */
function PendingWorkStrip({
  items,
  onAction,
  maxRows = PENDING_MAX_ROWS,
  collapsed = false,
  className = ''
}) {
  const { t, i18n } = useTranslation();
  const listId = useId();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const restoreRef = useRef(null);
  const list = Array.isArray(items) ? items.filter(item => item?.id) : [];

  // The removed item has left the list: move the focus to where it was. Only the
  // list that answers the removal counts; an entry never outlives it.
  const ids = idsOf(list);
  useEffect(() => {
    const restore = restoreRef.current;
    if (!restore || ids === restore.ids) return;
    restoreRef.current = null;
    // Still listed after the list changed: the removal did not happen.
    if (ids.split('\n').includes(restore.id)) return;
    // Only when the focus went with the removed button; never away from where the person went.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    restoreTarget(rootRef.current, restore.index)?.focus();
  }, [ids]);

  if (list.length === 0) return null;

  const foldable = collapsed || list.length > maxRows;
  const folded = foldable && !open;
  let shown = list;
  if (folded) shown = collapsed ? [] : list.slice(0, maxRows);

  const act = (action, item) => {
    if (action === 'remove') {
      const index = shown.findIndex(entry => entry.id === item.id);
      restoreRef.current = { id: item.id, index: Math.max(index, 0), ids };
    }
    onAction?.(action, item);
  };

  return (
    <div
      ref={rootRef}
      className={`mx-2 mt-2 min-w-0 ${className}`}
      data-testid="pending-work-strip"
    >
      <ul
        id={listId}
        aria-label={t('chat.pending.listLabel', 'Pending in this chat')}
        className={`flex flex-col gap-1 ${open && list.length > maxRows ? 'max-h-40 overflow-y-auto' : ''}`}
      >
        {shown.map(item => {
          const label = pendingLabel(t, item.labelKey, i18n);
          const whole = expandedId === item.id;
          return (
            <li
              key={item.id}
              data-testid="pending-item"
              className="flex min-w-0 items-start gap-2 rounded-md bg-gray-50 px-2 py-1 text-xs text-gray-800 dark:bg-gray-900/40 dark:text-gray-200"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex-none text-gray-500 dark:text-gray-400"
              >
                <Icon name={KIND_ICONS[item.kind] || 'chat-bubble-left'} size="xs" />
              </span>
              <button
                type="button"
                aria-expanded={whole}
                onClick={() => setExpandedId(whole ? null : item.id)}
                className="min-w-0 flex-1 rounded text-left focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <span className={`block ${whole ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
                  {label && <span className="font-medium">{`${label}: `}</span>}
                  {item.text}
                </span>
              </button>
              {(item.actions || []).map(action => (
                <ActionButton key={action} action={action} item={item} onAction={act} t={t} />
              ))}
            </li>
          );
        })}
      </ul>
      {foldable && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(value => !value)}
          className="mt-1 inline-flex min-h-6 items-center rounded px-1 text-xs font-medium text-indigo-700 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
        >
          {open
            ? t('chat.pending.showLess', 'Show less')
            : t('chat.pending.showAll', '{{count}} pending · Show all', { count: list.length })}
        </button>
      )}
    </div>
  );
}

export default PendingWorkStrip;
