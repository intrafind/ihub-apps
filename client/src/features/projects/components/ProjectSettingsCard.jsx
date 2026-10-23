// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updateProject } from '../../../api';
import Modal from '../../../shared/components/Modal';
import { projectErrorMessage } from '../utils/projectErrors';
import { localizedText } from '../utils/projectItems';
import {
  buildProjectChanges,
  projectFormFrom,
  reconcileProjectForm,
  validateProjectForm
} from '../utils/projectView';
import { useProjectChatApps } from './ProjectAppSelect';
import ProjectFormFields from './ProjectFormFields';
import ProjectPanelRow, { ROW_ACTION } from './ProjectPanelRow';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './item-dialog/dialogStyles';

const PREVIEW = 'text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words line-clamp-3';
const EMPTY = 'text-gray-400 dark:text-gray-500';

/**
 * The instructions and the default app of a project, as rows of the project
 * page's side panel. The owner and editors edit them, with the name and the
 * description, in a dialog (`PATCH /api/projects/:id`, only what changed);
 * everyone else reads the instructions.
 *
 * The draft lives here, not in the dialog: closing the dialog keeps an
 * unsaved edit, and a newer copy of the project (a poll, another editor's
 * save) updates only the fields the user has not touched.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {boolean} props.editable
 * @param {(project: Object) => void} props.onSaved
 * @returns {JSX.Element}
 */
function ProjectSettingsCard({ project, editable, onSaved }) {
  const { t, i18n } = useTranslation();
  const { choices } = useProjectChatApps();
  const [form, setForm] = useState(() => projectFormFrom(project));
  // What the draft started from. Changes are measured against it, not
  // against the latest project, so a newer copy from a poll never makes an
  // untouched field look like a local edit.
  const [base, setBase] = useState(form);
  // Follow each new copy of the project (state adjusted during render):
  // another project re-fills the form; a newer copy of this one updates the
  // fields the user has not touched and leaves unsaved edits alone.
  const [syncedWith, setSyncedWith] = useState(project);
  if (project !== syncedWith) {
    setSyncedWith(project);
    if (project.id !== syncedWith.id) {
      resetTo(project);
    } else {
      const next = reconcileProjectForm(form, base, project);
      setForm(next.form);
      setBase(next.base);
    }
  }
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const changes = editable ? buildProjectChanges(form, base) : null;

  /** Start the draft over from `source` (after a save, a discard, another project). */
  function resetTo(source) {
    const fresh = projectFormFrom(source);
    setForm(fresh);
    setBase(fresh);
  }

  const instructions = project.instructions || '';
  const defaultApp = project.defaultAppId
    ? choices.find(({ app }) => app.id === project.defaultAppId)
    : null;

  const openEditor = () => {
    setMessage(null);
    setEditing(true);
  };

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
      resetTo(saved);
      setEditing(false);
      setMessage({ ok: true, text: t('projects.settings.saved', 'Saved.') });
    } catch (err) {
      setMessage({ ok: false, text: projectErrorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };

  const instructionsRow = (
    <ProjectPanelRow
      icon="document-text"
      title={t('projects.settings.title', 'Instructions')}
      titleId="project-instructions-title"
      action={
        editable ? (
          <button
            type="button"
            onClick={openEditor}
            className={ROW_ACTION}
            aria-label={t('projects.settings.editInstructions', 'Edit instructions')}
          >
            {instructions ? t('common.edit', 'Edit') : t('projects.panel.add', 'Add')}
          </button>
        ) : instructions ? (
          <button
            type="button"
            onClick={() => setViewing(true)}
            className={ROW_ACTION}
            aria-label={t('projects.settings.viewInstructions', 'View instructions')}
          >
            {t('projects.panel.view', 'View')}
          </button>
        ) : null
      }
    >
      {instructions ? (
        <p className={PREVIEW}>{instructions}</p>
      ) : (
        <p className={EMPTY}>{t('projects.settings.noInstructions', 'No instructions.')}</p>
      )}
    </ProjectPanelRow>
  );

  return (
    <>
      {instructionsRow}
      <ProjectPanelRow
        icon="chat-bubble-left-right"
        title={t('projects.form.defaultApp', 'Default app')}
        titleId="project-default-app-title"
        action={
          editable ? (
            <button
              type="button"
              onClick={openEditor}
              className={ROW_ACTION}
              aria-label={t('projects.settings.changeDefaultApp', 'Change default app')}
            >
              {t('projects.panel.change', 'Change')}
            </button>
          ) : null
        }
      >
        <p
          className={
            defaultApp || project.defaultAppId ? 'text-gray-600 dark:text-gray-400' : EMPTY
          }
        >
          {defaultApp
            ? defaultApp.name
            : project.defaultAppId
              ? t('projects.appSelect.unavailable', '{{id}} (not available)', {
                  id: project.defaultAppId
                })
              : t('projects.settings.noDefaultApp', 'None — the first app is used')}
        </p>
      </ProjectPanelRow>
      {message && !editing && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`px-4 py-2 text-sm ${message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
        >
          {message.text}
        </p>
      )}

      {editable && (
        <Modal
          isOpen={editing}
          onClose={() => setEditing(false)}
          labelledBy="project-settings-title"
          maxWidthClassName="max-w-2xl"
        >
          <form onSubmit={handleSave} className="flex flex-col min-h-0">
            <div className="px-6 pt-5 pb-4 overflow-y-auto">
              <h2
                id="project-settings-title"
                className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4"
              >
                {t('projects.settings.editTitle', 'Settings')}
              </h2>
              <ProjectFormFields
                form={form}
                errors={errors}
                idPrefix="project-settings"
                showDefaultApp
                // Read-only while the save is out: the answer resets the draft to
                // what was saved, which would silently drop an edit made meanwhile.
                disabled={saving}
                onChange={(field, value) => {
                  setForm(prev => ({ ...prev, [field]: value }));
                  setMessage(null);
                }}
              />
            </div>
            <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-end gap-2">
              {message && !message.ok && (
                <p role="alert" className="mr-auto text-sm text-red-600 dark:text-red-400">
                  {message.text}
                </p>
              )}
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  resetTo(project);
                  setEditing(false);
                }}
                className={SECONDARY_BUTTON}
              >
                {changes
                  ? t('projects.settings.reset', 'Discard changes')
                  : t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" disabled={!changes || saving} className={PRIMARY_BUTTON}>
                {saving ? t('projects.settings.saving', 'Saving…') : t('common.save', 'Save')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <Modal
        isOpen={viewing}
        onClose={() => setViewing(false)}
        labelledBy="project-instructions-view-title"
        maxWidthClassName="max-w-2xl"
      >
        <div className="px-6 pt-5 pb-4 overflow-y-auto">
          <h2
            id="project-instructions-view-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('projects.settings.title', 'Instructions')}
          </h2>
          {localizedText(project.description, i18n.language) && (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {localizedText(project.description, i18n.language)}
            </p>
          )}
          <pre className="mt-3 whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 rounded-md p-3 border border-gray-200 dark:border-gray-700">
            {instructions}
          </pre>
        </div>
        <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/40 flex justify-end">
          <button type="button" onClick={() => setViewing(false)} className={SECONDARY_BUTTON}>
            {t('common.close', 'Close')}
          </button>
        </div>
      </Modal>
    </>
  );
}

export default ProjectSettingsCard;
