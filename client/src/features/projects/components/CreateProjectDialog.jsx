// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import { createProject } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import { buildCreateProjectBody, validateProjectForm } from '../utils/projectView';
import ProjectFormFields from './ProjectFormFields';
import { LABEL_CLASS, PRIMARY_BUTTON, SECONDARY_BUTTON } from './item-dialog/dialogStyles';

/**
 * Creates a user project (`POST /api/projects`): a name, and optionally a
 * description and instructions. Items, members and chats are added on the
 * project page the caller lands on afterwards.
 *
 * Where the caller can use the iFinder tier and this installation can change
 * smart collections (`ifinderWritable`), they also pick where the project lives:
 * in iHub, or as a smart collection in iFinder (the name and the description go
 * to iFinder; the instructions and the default app stay with its project here).
 *
 * Mount it only while open, so every opening starts empty.
 *
 * @param {Object} props
 * @param {() => void} props.onClose
 * @param {(project: Object) => void} props.onCreated
 * @param {boolean} [props.ifinderWritable=false] - Offer the iFinder tier.
 * @returns {JSX.Element}
 */
function CreateProjectDialog({ onClose, onCreated, ifinderWritable = false }) {
  const { t } = useTranslation();
  const [tier, setTier] = useState('ihub');
  const [form, setForm] = useState({ name: '', description: '', instructions: '' });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const firstFieldRef = useRef(null);

  const handleSubmit = async event => {
    event.preventDefault();
    const nextErrors = validateProjectForm(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await createProject(buildCreateProjectBody(form, { tier })));
    } catch (err) {
      setError(projectErrorMessage(err, t));
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      labelledBy="create-project-title"
      initialFocusRef={firstFieldRef}
    >
      <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
        <div className="px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
          <h2
            id="create-project-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('projects.create.title', 'New project')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t(
              'projects.create.subtitle',
              'A project keeps documents, instructions and chats together. It stays private until you share it.'
            )}
          </p>
        </div>
        <div className="px-6 py-4 overflow-y-auto" ref={firstFieldRef} tabIndex={-1}>
          {ifinderWritable && (
            <fieldset className="mb-4" data-testid="create-project-tier">
              <legend className={LABEL_CLASS}>
                {t('projects.create.tier', 'Where to keep it')}
              </legend>
              <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
                {[
                  [
                    'ihub',
                    t('projects.create.tierIhub', 'In iHub'),
                    t(
                      'projects.create.tierIhubHint',
                      'Files, web pages and text, with instructions and sharing.'
                    )
                  ],
                  [
                    'ifinder',
                    t('projects.create.tierIfinder', 'As an iFinder smart collection'),
                    t(
                      'projects.create.tierIfinderHint',
                      'A list of iFinder documents you can read. It also shows up in iFinder.'
                    )
                  ]
                ].map(([value, label, hint]) => (
                  <label key={value} className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="create-project-tier"
                      value={value}
                      checked={tier === value}
                      onChange={() => setTier(value)}
                      className="mt-1 h-4 w-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
                    />
                    <span>
                      {label}
                      <span className="block text-xs text-gray-500 dark:text-gray-400">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <ProjectFormFields
            form={form}
            errors={errors}
            idPrefix="create-project"
            onChange={(field, value) => setForm(prev => ({ ...prev, [field]: value }))}
          />
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
            {saving
              ? t('projects.create.creating', 'Creating…')
              : tier === 'ifinder'
                ? t('projects.create.submitCollection', 'Create collection')
                : t('projects.create.submit', 'Create project')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default CreateProjectDialog;
