// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { MAX_ITEM_NAME_LENGTH } from '../utils/projectView';
import { buildItemChanges, draftFromItem } from '../utils/projectItems';
import { LinkKindPicker } from './item-dialog/ItemPickers';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON
} from './item-dialog/dialogStyles';

/** What a validation code of `buildItemChanges` says. */
function validationMessage(t, code) {
  switch (code) {
    case 'urlInvalid':
      return t('projects.addItem.errors.urlInvalid', 'Enter a valid http(s) URL.');
    case 'pageRequired':
      return t('projects.addItem.errors.pageRequired', 'Choose a page.');
    case 'documentRequired':
      return t('projects.addItem.errors.documentRequired', 'Search iFinder and choose a document.');
    case 'queryRequired':
      return t('projects.addItem.errors.queryRequired', 'Enter a search query.');
    default:
      return t('projects.editItem.unsupported', 'This kind of item cannot be edited.');
  }
}

/**
 * Edits one link item of a project — a web page, an iHub page, an iFinder
 * document or an iFinder search — in the pickers the add dialog uses, filled
 * with what the item holds now. It changes the item in place: its id, its
 * pin and its place in the project stay.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {Object} props.item - The item to edit (one of `EDITABLE_ITEM_KINDS`).
 * @param {() => void} props.onClose
 * @param {(changes: {name?: string, ref?: Object}) => Promise<void>} props.onSave -
 *   Rejects with the failure, which the dialog shows.
 * @param {import('./AddProjectItemDialog').ProjectItemApi} props.api - The pickers' loaders.
 * @returns {JSX.Element}
 */
function EditItemDialog({ item, onClose, onSave, api }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => draftFromItem(item));
  const [pages, setPages] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const update = changes => setDraft(prev => ({ ...prev, ...changes }));

  useEffect(() => {
    if (item.kind !== 'page') return;
    api
      .fetchPages()
      .then(setPages)
      .catch(err => {
        setPages([]);
        setError(api.errorMessage(err));
      });
  }, [item.kind, api]);

  const handleSubmit = async event => {
    event.preventDefault();
    setError(null);
    const { changes, error: code } = buildItemChanges(item, draft);
    if (code) return setError(validationMessage(t, code));
    // Nothing differs: there is nothing to save.
    if (!changes) return onClose();
    setSaving(true);
    try {
      await onSave(changes);
      return onClose();
    } catch (err) {
      return setError(api.errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={saving ? () => {} : onClose}
      maxWidthClassName="max-w-3xl"
      labelledBy="edit-item-title"
    >
      <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
        <div className="px-6 pt-5 pb-4 space-y-4 overflow-y-auto">
          <h2
            id="edit-item-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('projects.editItem.title', 'Edit item')}
          </h2>
          {/* No crawl: it adds pages, and this edits one. */}
          <LinkKindPicker kind={item.kind} draft={draft} update={update} api={api} pages={pages} />
          <div>
            <label htmlFor="edit-item-name" className={LABEL_CLASS}>
              {t('projects.addItem.name', 'Name')}
            </label>
            <input
              id="edit-item-name"
              type="text"
              value={draft.name}
              maxLength={MAX_ITEM_NAME_LENGTH}
              onChange={e => update({ name: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400 whitespace-pre-line">
              {error}
            </p>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className={SECONDARY_BUTTON}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
            {saving && <Icon name="arrow-path" size="sm" className="animate-spin mr-2" />}
            {t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default EditItemDialog;
