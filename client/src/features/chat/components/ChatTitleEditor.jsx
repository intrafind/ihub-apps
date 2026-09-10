import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Longest title the server stores (`MAX_TITLE_LENGTH` in ChatRepository). */
const MAX_TITLE_LENGTH = 200;

/**
 * Inline rename field for a chat title.
 *
 * One component for both places a chat can be renamed — the history page row
 * and the sidebar's Recents row — so the two never drift apart. It owns the
 * draft and the keyboard contract only; persisting the new title (and leaving
 * edit mode) is the caller's job, which keeps this usable inside a `<Link>`
 * row, a card, or anything else.
 *
 * Commit/cancel semantics are the ones the message editor already teaches
 * (`ChatMessage.jsx`): focus on entry with the caret at the end, Escape
 * cancels, an unchanged or emptied field is a no-op rather than a write.
 * Enter commits (a title is one line, so there is nothing for it to insert),
 * and so does a blur — clicking away from a rename means "keep what I typed",
 * not "throw it away".
 *
 * @param {Object} props - Component properties.
 * @param {string} [props.value] - The title as stored; the draft starts here.
 * @param {(title: string) => void} props.onCommit - Called with the new, trimmed title.
 * @param {() => void} [props.onCancel] - Called when the edit ends without a change.
 * @param {string} [props.placeholder] - Placeholder for an as-yet untitled chat.
 * @param {string} [props.label] - Accessible name; defaults to "Chat title".
 * @param {string} [props.className] - Extra classes for the input.
 * @returns {JSX.Element} The ChatTitleEditor component.
 */
function ChatTitleEditor({ value = '', onCommit, onCancel, placeholder, label, className = '' }) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const [draft, setDraft] = useState(value);
  // Committing and cancelling both end the edit, and ending it blurs the
  // input — without this the blur would commit a second time, right after a
  // cancel discarded the draft.
  const settledRef = useRef(false);

  useEffect(() => {
    setDraft(value);
    settledRef.current = false;
  }, [value]);

  // Entering edit mode focuses the field with the caret at the end, so typing
  // extends the existing title instead of replacing it.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const pos = el.value.length;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // setSelectionRange can throw on some input types; ignore.
    }
  }, []);

  const commit = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = draft.trim();
    // An emptied field reads as "I changed my mind", not "erase the title" —
    // the same call the message editor makes. Unchanged is a no-op too, so a
    // stray click into a row never writes.
    if (!trimmed || trimmed === value.trim()) {
      onCancel?.();
      return;
    }
    onCommit?.(trimmed);
  }, [draft, onCancel, onCommit, value]);

  const cancel = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel?.();
  }, [onCancel]);

  const handleKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Escape belongs to the editor while it is open: unstopped it would
      // also close the mobile sidebar drawer the row can live in.
      event.stopPropagation();
      cancel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      maxLength={MAX_TITLE_LENGTH}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={commit}
      // The editor can sit inside a clickable row; typing in it must not
      // navigate.
      onClick={event => event.stopPropagation()}
      placeholder={placeholder || t('chatHistory.titlePlaceholder', 'Name this chat')}
      aria-label={label || t('chatHistory.titleLabel', 'Chat title')}
      className={`w-full min-w-0 rounded-lg border border-indigo-400 bg-white px-2 py-1 text-sm text-gray-900 outline-hidden focus:border-indigo-500 dark:border-indigo-500 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 ${className}`}
    />
  );
}

export default ChatTitleEditor;
