// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updateProject } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';
import { localizedText } from '../utils/projectItems';
import { buildProjectChanges, projectFormFrom, validateProjectForm } from '../utils/projectView';
import ProjectFormFields from './ProjectFormFields';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './item-dialog/dialogStyles';

const CARD =
  'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5';

/**
 * Name, description and instructions of a project: a form for the owner and
 * editors (`PATCH /api/projects/:id`, only what changed), plain text for
 * everyone else.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {boolean} props.editable
 * @param {(project: Object) => void} props.onSaved
 * @returns {JSX.Element}
 */
function ProjectSettingsCard({ project, editable, onSaved }) {
  const { t, i18n } = useTranslation();
  const [form, setForm] = useState(() => projectFormFrom(project));
  // Re-fill the form when another project is shown (state adjusted during
  // render); polling the same project leaves unsaved edits alone.
  const [formFor, setFormFor] = useState(project.id);
  if (project.id !== formFor) {
    setFormFor(project.id);
    setForm(projectFormFrom(project));
  }
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const changes = editable ? buildProjectChanges(form, project) : null;

  if (!editable) {
    const description = localizedText(project.description, i18n.language);
    return (
      <section className={CARD} aria-labelledby="project-settings-title">
        <h2
          id="project-settings-title"
          className="text-base font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('projects.settings.title', 'Instructions')}
        </h2>
        {description && (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{description}</p>
        )}
        <pre className="mt-3 whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 rounded-md p-3 border border-gray-200 dark:border-gray-700">
          {project.instructions || t('projects.settings.noInstructions', 'No instructions.')}
        </pre>
      </section>
    );
  }

  const handleSave = async event => {
    event.preventDefault();
    const nextErrors = validateProjectForm(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !changes) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await updateProject(project.id, changes);
      onSaved(saved);
      setForm(projectFormFrom(saved));
      setMessage({ ok: true, text: t('projects.settings.saved', 'Saved.') });
    } catch (err) {
      setMessage({ ok: false, text: projectErrorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={CARD} aria-labelledby="project-settings-title">
      <h2
        id="project-settings-title"
        className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3"
      >
        {t('projects.settings.editTitle', 'Settings')}
      </h2>
      <form onSubmit={handleSave}>
        <ProjectFormFields
          form={form}
          errors={errors}
          idPrefix="project-settings"
          onChange={(field, value) => {
            setForm(prev => ({ ...prev, [field]: value }));
            setMessage(null);
          }}
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          {message && (
            <p
              role={message.ok ? 'status' : 'alert'}
              className={`mr-auto text-sm ${message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
            >
              {message.text}
            </p>
          )}
          <button
            type="button"
            disabled={!changes || saving}
            onClick={() => setForm(projectFormFrom(project))}
            className={SECONDARY_BUTTON}
          >
            {t('projects.settings.reset', 'Discard changes')}
          </button>
          <button type="submit" disabled={!changes || saving} className={PRIMARY_BUTTON}>
            {saving ? t('projects.settings.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </section>
  );
}

export default ProjectSettingsCard;
