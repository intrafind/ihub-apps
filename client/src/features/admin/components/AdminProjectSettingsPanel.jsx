// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminApiErrorMessage, updateAdminProject } from '../../../api/adminApi';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import Modal from '../../../shared/components/Modal';
import ProjectPanelRow, { PANEL_CARD, ROW_ACTION } from '../../projects/components/ProjectPanelRow';
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON
} from '../../projects/components/item-dialog/dialogStyles';
import { localizedText } from '../../projects/utils/projectItems';
import {
  buildProjectPayload,
  parseTags,
  projectAvailability,
  projectFormFromProject,
  validateProjectForm
} from '../utils/projectAdmin';
import {
  ProjectCategoryTagsFields,
  ProjectDefaultAppField,
  ProjectInstructionsField
} from './AdminProjectSettingsForm';
import ProjectAvailability, {
  ProjectAvailabilityBadge,
  availabilityOptions
} from './ProjectAvailability';

/** How long "Saved." stays on screen. */
const SAVED_NOTICE_MS = 4000;

/**
 * One part of an admin project's settings in a dialog: its name and
 * description (with category and tags), its instructions, or who can use
 * it. Save writes the whole project (`PUT /api/admin/projects/:id`) right
 * away; Cancel drops the draft. Mount it only while open.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {'details'|'instructions'|'availability'} props.section
 * @param {() => void} props.onClose
 * @param {(project: Object) => void} props.onSaved
 * @returns {JSX.Element}
 */
function AdminProjectSettingsDialog({ project, section, onClose, onSaved }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(() => projectFormFromProject(project));
  const [tagsText, setTagsText] = useState(() => form.tags.join(', '));
  const [nameError, setNameError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const next = { ...form, tags: parseTags(tagsText) };
  const changed =
    JSON.stringify(buildProjectPayload(next)) !==
    JSON.stringify(buildProjectPayload(projectFormFromProject(project)));
  // Opening the project to everyone says what it opens next to the button that does it.
  const opensToEveryone =
    projectAvailability(next) === 'everyone' && projectAvailability(project) !== 'everyone';

  const update = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (field === 'name') setNameError(null);
  };

  const handleSave = async event => {
    event.preventDefault();
    if (validateProjectForm(next, { isNew: false }).name) {
      setNameError(t('admin.projects.validation.nameRequired', 'A name is required.'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = buildProjectPayload(next);
      const updated = await updateAdminProject(project.id, payload);
      onSaved(updated || { ...project, ...payload });
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setSaving(false);
    }
  };

  const titles = {
    details: t('admin.projects.panel.details', 'Name and description'),
    instructions: t('admin.projects.fields.instructions', 'Instructions'),
    availability: t('admin.projects.panel.availability', 'Availability')
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      labelledBy="admin-project-settings-dialog-title"
      maxWidthClassName="max-w-2xl"
    >
      <form onSubmit={handleSave} noValidate className="flex flex-col min-h-0">
        <div className="px-6 pt-5 pb-4 overflow-y-auto space-y-5">
          <h2
            id="admin-project-settings-dialog-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {titles[section]}
          </h2>

          {section === 'details' && (
            <>
              <DynamicLanguageEditor
                label={t('admin.projects.fields.name', 'Name')}
                required
                value={form.name}
                onChange={value => update('name', value)}
                placeholder={t('admin.projects.fields.namePlaceholder', 'Project name')}
                error={nameError}
              />
              <DynamicLanguageEditor
                label={t('admin.projects.fields.description', 'Description')}
                rows={2}
                value={form.description}
                onChange={value => update('description', value)}
                placeholder={t(
                  'admin.projects.fields.descriptionPlaceholder',
                  'What this project contains'
                )}
                type="textarea"
              />
              <ProjectCategoryTagsFields
                category={form.category}
                tagsText={tagsText}
                onCategoryChange={value => update('category', value)}
                onTagsTextChange={setTagsText}
              />
              <ProjectDefaultAppField
                value={form.defaultAppId}
                onChange={value => update('defaultAppId', value)}
              />
            </>
          )}

          {section === 'instructions' && (
            <ProjectInstructionsField
              rows={10}
              value={form.instructions}
              onChange={value => update('instructions', value)}
            />
          )}

          {section === 'availability' && (
            <>
              <ProjectAvailability
                compact
                confirmEveryone={false}
                value={form}
                onChange={flags => setForm(prev => ({ ...prev, ...flags }))}
              />
              {opensToEveryone && (
                <p
                  role="status"
                  className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-800 dark:text-amber-200"
                >
                  {t(
                    'admin.projects.publish.confirmMessage',
                    'It is then listed in the project catalog. Everyone signed in can read its documents and instructions and link them into their own projects, also those who may not use the apps, workflows or agents that link it. Only administrators can change it.'
                  )}
                </p>
              )}
            </>
          )}
        </div>
        <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-end gap-2">
          {error && (
            <p role="alert" className="mr-auto text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <button type="button" disabled={saving} onClick={onClose} className={SECONDARY_BUTTON}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" disabled={!changed || saving} className={PRIMARY_BUTTON}>
            {saving
              ? t('common.saving', 'Saving...')
              : opensToEveryone
                ? t('admin.projects.publish.confirm', 'Make available')
                : t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The settings of an admin project as rows of the side panel, the way a
 * user's project page shows its own: name and description, instructions,
 * and who can use it. Each row's action opens a dialog that saves that part
 * at once, so there is no form to keep track of beside the items.
 *
 * @param {Object} props
 * @param {Object} props.project - As `GET /api/admin/projects/:id` returns it.
 * @param {(project: Object) => void} props.onSaved - The project as saved.
 * @returns {JSX.Element}
 */
function AdminProjectSettingsPanel({ project, onSaved }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const [editing, setEditing] = useState(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef(null);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const description = localizedText(project.description, language);
  const availability = availabilityOptions(t).find(
    option => option.id === projectAvailability(project)
  );

  const handleSaved = updated => {
    setEditing(null);
    onSaved(updated);
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), SAVED_NOTICE_MS);
  };

  return (
    <div className={`${PANEL_CARD} min-w-0`} data-testid="project-side-panel">
      <ProjectPanelRow
        icon="pencil"
        title={t('admin.projects.panel.details', 'Name and description')}
        titleId="admin-project-details-title"
        action={
          <button
            type="button"
            onClick={() => setEditing('details')}
            className={ROW_ACTION}
            aria-label={t('admin.projects.panel.editDetails', 'Edit name and description')}
          >
            {t('common.edit', 'Edit')}
          </button>
        }
      >
        {description ? (
          <p className="text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words">
            {description}
          </p>
        ) : (
          <p className="text-gray-500 dark:text-gray-400">
            {t('admin.projects.view.noDescription', 'No description.')}
          </p>
        )}
        {(project.category || (project.tags || []).length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {project.category && (
              <span className="text-xs text-gray-600 dark:text-gray-400">{project.category}</span>
            )}
            {(project.tags || []).map(tag => (
              <span
                key={tag}
                className="px-2 py-0.5 text-xs rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('admin.projects.fields.defaultApp', 'Default app')}:{' '}
          {project.defaultAppId ||
            t('admin.projects.fields.defaultAppNone', 'No default (first available app)')}
        </p>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('admin.projects.fields.id', 'Project ID')}:{' '}
          <code className="font-mono">{project.id}</code>
        </p>
      </ProjectPanelRow>
      <ProjectPanelRow
        icon="document-text"
        title={t('admin.projects.fields.instructions', 'Instructions')}
        titleId="admin-project-instructions-title"
        action={
          <button
            type="button"
            onClick={() => setEditing('instructions')}
            className={ROW_ACTION}
            aria-label={
              project.instructions
                ? t('projects.settings.editInstructions', 'Edit instructions')
                : t('projects.settings.addInstructions', 'Add instructions')
            }
          >
            {project.instructions ? t('common.edit', 'Edit') : t('projects.panel.add', 'Add')}
          </button>
        }
      >
        {project.instructions ? (
          <pre className="max-h-48 overflow-y-auto text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words font-sans">
            {project.instructions}
          </pre>
        ) : (
          <p className="text-gray-500 dark:text-gray-400">
            {t('admin.projects.view.noInstructions', 'No instructions.')}
          </p>
        )}
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.projects.view.instructionsHint',
            'The instructions are added to the system prompt of every app, workflow step or agent that links this project.'
          )}
        </p>
      </ProjectPanelRow>
      <ProjectPanelRow
        icon="globe"
        title={t('admin.projects.panel.availability', 'Availability')}
        titleId="admin-project-availability-title"
        action={
          <button
            type="button"
            onClick={() => setEditing('availability')}
            className={ROW_ACTION}
            aria-label={t('admin.projects.view.changeVisibility', 'Change visibility')}
          >
            {t('projects.panel.change', 'Change')}
          </button>
        }
      >
        <ProjectAvailabilityBadge project={project} />
        <p className="mt-2 text-gray-600 dark:text-gray-400">{availability?.hint}</p>
      </ProjectPanelRow>
      {/* Always in the page, so a screen reader announces it when it arrives. */}
      <p
        role="status"
        className={`text-sm empty:hidden ${saved ? 'px-4 py-2 text-green-700 dark:text-green-400' : ''}`}
      >
        {saved ? t('admin.projects.panel.saved', 'Saved.') : ''}
      </p>

      {editing && (
        <AdminProjectSettingsDialog
          project={project}
          section={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

export default AdminProjectSettingsPanel;
