// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import { MAX_ITEM_NAME_LENGTH } from '../utils/projectView';
import {
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON
} from './item-dialog/dialogStyles';

/**
 * Renames one project item. Two items may share a name; the id is the
 * identity, so nothing is checked beyond length.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {Object} props.item
 * @param {() => void} props.onClose
 * @param {(name: string) => Promise<boolean>} props.onRename - Resolves `true` on success.
 * @returns {JSX.Element}
 */
function RenameItemDialog({ item, onClose, onRename }) {
  const { t } = useTranslation();
  const [name, setName] = useState(item.name || '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const trimmed = name.trim();
  const valid =
    trimmed.length > 0 && trimmed.length <= MAX_ITEM_NAME_LENGTH && trimmed !== item.name;

  const handleSubmit = async event => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    const ok = await onRename(trimmed);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} labelledBy="rename-item-title" initialFocusRef={inputRef}>
      <form onSubmit={handleSubmit}>
        <div className="px-6 pt-5 pb-4 space-y-3">
          <h2
            id="rename-item-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('projects.items.renameTitle', 'Rename item')}
          </h2>
          <div>
            <label htmlFor="rename-item-name" className={LABEL_CLASS}>
              {t('projects.addItem.name', 'Name')}
            </label>
            <input
              id="rename-item-name"
              ref={inputRef}
              type="text"
              value={name}
              maxLength={MAX_ITEM_NAME_LENGTH}
              onChange={e => setName(e.target.value)}
              className={INPUT_CLASS}
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" disabled={!valid || saving} className={PRIMARY_BUTTON}>
            {t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default RenameItemDialog;
