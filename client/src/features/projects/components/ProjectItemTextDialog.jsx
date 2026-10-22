// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import {
  ITEM_TEXT_EDIT_CHARS,
  ITEM_TEXT_PREVIEW_CHARS,
  isItemTextEditable
} from '../utils/projectItems';

const EMPTY_STATE = { loading: false, text: '', chars: null, truncated: false, error: null };
const NOT_EDITING = { draft: null, loading: false, saving: false, error: null };

/**
 * Shows the plain text the model gets from one item: the extracted text of
 * a stored item, or the live content of a linked one. At most
 * {@link ITEM_TEXT_PREVIEW_CHARS} characters are loaded. The admin editor
 * and the user project page pass their own text loader.
 *
 * With `onSave`, the text of a written, uploaded or imported document can
 * be edited in place (the successor of editing a source file): the whole
 * text is loaded into a text area, and saving replaces the stored document.
 *
 * @param {Object} props
 * @param {string} props.projectId
 * @param {Object|null} props.item - The item to preview; `null` closes the dialog.
 * @param {() => void} props.onClose
 * @param {(projectId: string, itemId: string, options: {maxChars: number}) =>
 *   Promise<{text: string, chars: number|null, truncated: boolean}>} props.fetchText
 * @param {(text: string) => Promise<Object|undefined>} [props.onSave] - Stores the
 *   new text; rejects with the error to show. Without it the dialog is read-only.
 * @param {(error: Error) => string} props.errorMessage
 * @returns {JSX.Element|null}
 */
function ProjectItemTextDialog({ projectId, item, onClose, fetchText, onSave, errorMessage }) {
  const { t } = useTranslation();
  const [state, setState] = useState(EMPTY_STATE);
  const [editing, setEditing] = useState(NOT_EDITING);

  useEffect(() => {
    if (!item) return undefined;
    let cancelled = false;
    setState({ ...EMPTY_STATE, loading: true });
    // A draft of the previous item is dropped once this one's text is in.
    fetchText(projectId, item.id, { maxChars: ITEM_TEXT_PREVIEW_CHARS })
      .then(result => {
        if (cancelled) return;
        setState({ ...EMPTY_STATE, ...result });
        setEditing(NOT_EDITING);
      })
      .catch(err => {
        if (cancelled) return;
        setState({ ...EMPTY_STATE, error: errorMessage(err) });
        setEditing(NOT_EDITING);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, item, fetchText, errorMessage]);

  const editable = typeof onSave === 'function' && isItemTextEditable(item);
  const isEditing = editing.draft !== null || editing.loading;

  const startEditing = async () => {
    if (!state.truncated) {
      setEditing({ ...NOT_EDITING, draft: state.text });
      return;
    }
    // The preview holds only the first part: the whole text is edited.
    setEditing({ ...NOT_EDITING, loading: true });
    try {
      const whole = await fetchText(projectId, item.id, { maxChars: ITEM_TEXT_EDIT_CHARS });
      setEditing({ ...NOT_EDITING, draft: whole.text });
    } catch (err) {
      setEditing({ ...NOT_EDITING, error: errorMessage(err) });
    }
  };

  const save = async () => {
    const text = editing.draft;
    setEditing(current => ({ ...current, saving: true, error: null }));
    try {
      await onSave(text);
      setState({ ...EMPTY_STATE, text, chars: text.length, truncated: false });
      setEditing(NOT_EDITING);
    } catch (err) {
      setEditing(current => ({ ...current, saving: false, error: errorMessage(err) }));
    }
  };

  const draftEmpty = !editing.draft || editing.draft.trim().length === 0;

  return (
    <Modal
      isOpen={Boolean(item)}
      onClose={onClose}
      maxWidthClassName="max-w-4xl"
      labelledBy="project-item-text-title"
    >
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
        <h3
          id="project-item-text-title"
          className="text-lg font-medium text-gray-900 dark:text-gray-100 truncate"
        >
          {t('projects.preview.title', 'Text of "{{name}}"', { name: item?.name ?? '' })}
        </h3>
        {editable && !isEditing && !state.loading && !state.error && (
          <button
            type="button"
            onClick={() => void startEditing()}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600"
          >
            <Icon name="pencil" size="sm" />
            {t('projects.preview.edit', 'Edit text')}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className={`${editable && !isEditing && !state.loading && !state.error ? '' : 'ml-auto '}text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`}
        >
          <Icon name="x" className="h-5 w-5" />
        </button>
      </div>
      <div className="p-6 overflow-y-auto">
        {(state.loading || editing.loading) && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}
        {!state.loading && !state.error && editing.draft !== null && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                'projects.preview.editHint',
                'The saved text replaces the stored document; the model reads the new text from the next question on.'
              )}
            </p>
            <textarea
              aria-label={t('projects.preview.editLabel', 'Text of the document')}
              value={editing.draft}
              onChange={event =>
                setEditing(current => ({ ...current, draft: event.target.value, error: null }))
              }
              disabled={editing.saving}
              rows={20}
              spellCheck={false}
              className="w-full font-mono text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 p-3 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-60"
            />
            {editing.error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {editing.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(NOT_EDITING)}
                disabled={editing.saving}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-60"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={editing.saving || draftEmpty}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
              >
                {editing.saving
                  ? t('projects.preview.saving', 'Saving…')
                  : t('common.save', 'Save')}
              </button>
            </div>
          </div>
        )}
        {!state.loading && !state.error && editing.draft === null && !editing.loading && (
          <>
            {editing.error && (
              <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
                {editing.error}
              </p>
            )}
            {state.truncated && (
              <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">
                {t(
                  'projects.preview.truncated',
                  'Showing the first {{shown}} of {{total}} characters.',
                  {
                    shown: ITEM_TEXT_PREVIEW_CHARS.toLocaleString(),
                    total: (state.chars ?? 0).toLocaleString()
                  }
                )}
              </p>
            )}
            <pre className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 rounded-md p-4 border border-gray-200 dark:border-gray-700">
              {state.text || t('projects.preview.empty', '(no text)')}
            </pre>
          </>
        )}
      </div>
    </Modal>
  );
}

export default ProjectItemTextDialog;
