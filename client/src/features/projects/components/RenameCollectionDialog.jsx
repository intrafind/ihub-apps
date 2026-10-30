// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import { updateProject } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import {
  MAX_PROJECT_DESCRIPTION_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  projectDisplayName
} from '../utils/projectView';
import {
  HINT_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON
} from './item-dialog/dialogStyles';

/**
 * Renames a smart collection from iFinder (`PATCH /api/projects/:id`): its name
 * and its description, and nothing else. Only the fields that changed are sent.
 *
 * Mount it only while open, so every opening starts from the collection.
 *
 * @param {Object} props
 * @param {Object} props.project - The collection as a project.
 * @param {string} [props.language='en']
 * @param {() => void} props.onClose
 * @param {(project: Object) => void} props.onSaved - Called with the saved project.
 * @returns {JSX.Element}
 */
function RenameCollectionDialog({ project, language = 'en', onClose, onSaved }) {
  const { t } = useTranslation();
  const startName = projectDisplayName(project, language);
  const startDescription = typeof project.description === 'string' ? project.description : '';
  const [name, setName] = useState(startName);
  const [description, setDescription] = useState(startDescription);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef(null);

  const trimmedName = name.trim();
  const changes = {};
  if (trimmedName !== startName) changes.name = trimmedName;
  if (description.trim() !== startDescription) changes.description = description.trim();
  const nameError =
    trimmedName.length === 0
      ? t('projects.form.nameRequired', 'A name is required.')
      : trimmedName.length > MAX_PROJECT_NAME_LENGTH
        ? t('projects.form.tooLong', 'At most {{max}} characters.', {
            max: MAX_PROJECT_NAME_LENGTH.toLocaleString()
          })
        : null;
  const descriptionError =
    description.trim().length > MAX_PROJECT_DESCRIPTION_LENGTH
      ? t('projects.form.tooLong', 'At most {{max}} characters.', {
          max: MAX_PROJECT_DESCRIPTION_LENGTH.toLocaleString()
        })
      : null;

  const handleSubmit = async event => {
    event.preventDefault();
    if (nameError || descriptionError || Object.keys(changes).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await updateProject(project.id, changes));
    } catch (err) {
      setError(projectErrorMessage(err, t));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} labelledBy="rename-collection-title" initialFocusRef={nameRef}>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col min-h-0"
        data-testid="rename-collection"
      >
        <div className="px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
          <h2
            id="rename-collection-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('projects.ifinder.renameTitle', 'Rename collection')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t(
              'projects.ifinder.renameSubtitle',
              'The name and the description are changed in iFinder too.'
            )}
          </p>
        </div>
        <div className="px-6 py-4 overflow-y-auto space-y-4">
          <div>
            <label htmlFor="rename-collection-name" className={LABEL_CLASS}>
              {t('projects.form.name', 'Name')}
            </label>
            <input
              id="rename-collection-name"
              ref={nameRef}
              type="text"
              value={name}
              onChange={event => setName(event.target.value)}
              aria-invalid={nameError ? true : undefined}
              className={INPUT_CLASS}
            />
            {nameError && (
              <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                {nameError}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="rename-collection-description" className={LABEL_CLASS}>
              {t('projects.form.description', 'Description')}
            </label>
            <textarea
              id="rename-collection-description"
              rows={3}
              value={description}
              onChange={event => setDescription(event.target.value)}
              aria-invalid={descriptionError ? true : undefined}
              className={INPUT_CLASS}
            />
            {descriptionError && (
              <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                {descriptionError}
              </p>
            )}
            <p className={HINT_CLASS}>
              {t(
                'projects.ifinder.renameHint',
                'A smart collection has no instructions: it is a list of documents.'
              )}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            disabled={
              saving ||
              Boolean(nameError) ||
              Boolean(descriptionError) ||
              Object.keys(changes).length === 0
            }
            className={PRIMARY_BUTTON}
          >
            {saving ? t('projects.settings.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default RenameCollectionDialog;
