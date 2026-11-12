// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
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
import RefreshTtlDialog from './RefreshTtlDialog';
import { refreshModeLabel, refreshTtlLabel } from '../utils/refreshTtl';
import { knowledgeModeLabel } from '../utils/knowledgeModes';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './item-dialog/dialogStyles';

const PREVIEW = 'text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words line-clamp-3';
const EMPTY = 'text-gray-500 dark:text-gray-400';

/** How long "Saved." stays on screen. */
const SAVED_NOTICE_MS = 4000;

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
 * @param {boolean} [props.nameLocked=false] - The name and the description cannot be
 *   changed here (a smart collection where this installation cannot change
 *   collections in iFinder); the instructions and the default app still can.
 * @param {boolean} [props.showRefresh=false] - Show the refresh TTL of the
 *   project's files from websites and web pages (#3536).
 * @param {number|'never'|null} [props.platformRefreshTtl] - The installation's
 *   default, shown while the project sets none.
 * @param {'always'|'auto'|'onDemand'|null} [props.platformRefreshMode] - The installation's
 *   default refresh mode (#3622), shown while the project sets none.
 * @returns {JSX.Element}
 */
function ProjectSettingsCard({
  project,
  editable,
  onSaved,
  nameLocked = false,
  showRefresh = false,
  platformRefreshTtl = null,
  platformRefreshMode = null
}) {
  const { t, i18n } = useTranslation();
  const { choices, loading: appsLoading } = useProjectChatApps();
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
  // The field the dialog opens on: the one the row's action is about.
  const [focusField, setFocusField] = useState('name');
  // The dialog focuses this element on open. The field is rendered by
  // ProjectFormFields, so it is found by its id when the dialog asks.
  const initialFocusRef = useMemo(
    () => ({
      get current() {
        return document.getElementById(`project-settings-${focusField}`);
      }
    }),
    [focusField]
  );
  const [viewing, setViewing] = useState(false);
  const [schedulingRefresh, setSchedulingRefresh] = useState(false);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const changes = editable ? buildProjectChanges(form, base) : null;

  // "Saved." is a confirmation, not a state: it goes away after a moment.
  useEffect(() => {
    if (!message?.ok) return undefined;
    const timer = setTimeout(() => setMessage(null), SAVED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [message]);

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

  const openEditor = field => {
    setFocusField(field);
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
            onClick={() => openEditor('instructions')}
            className={ROW_ACTION}
            aria-label={
              instructions
                ? t('projects.settings.editInstructions', 'Edit instructions')
                : t('projects.settings.addInstructions', 'Add instructions')
            }
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
      {editable && (
        <ProjectPanelRow
          icon="pencil"
          title={t('projects.settings.details', 'Name and description')}
          titleId="project-details-title"
          action={
            <button
              type="button"
              onClick={() => openEditor('name')}
              className={ROW_ACTION}
              aria-label={t('projects.settings.editDetails', 'Edit name and description')}
            >
              {t('common.edit', 'Edit')}
            </button>
          }
        />
      )}
      {instructionsRow}
      {/* The default app is a user project's: an admin project's chats start
          in the apps that link it. */}
      {project.ownership === 'user' && (
        <ProjectPanelRow
          icon="chat-bubble-left-right"
          title={t('projects.form.defaultApp', 'Default app')}
          titleId="project-default-app-title"
          action={
            editable ? (
              <button
                type="button"
                onClick={() => openEditor('defaultAppId')}
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
                ? // The apps list is still loading: the app is not missing yet.
                  appsLoading
                  ? t('common.loading', 'Loading...')
                  : t('projects.appSelect.unavailable', '{{id}} (not available)', {
                      id: project.defaultAppId
                    })
                : t('projects.settings.noDefaultApp', 'None — the first app is used')}
          </p>
        </ProjectPanelRow>
      )}
      {/* How the project reaches the model (#3538); a collection that is not stored
          in iHub (no stub) has no setting of its own. */}
      {project.ownership === 'user' && !String(project.id).startsWith('ifc_') && (
        <ProjectPanelRow
          icon="sliders"
          title={t('projects.knowledgeMode.label', 'Knowledge mode')}
          titleId="project-knowledge-mode-title"
          action={
            editable ? (
              <button
                type="button"
                onClick={() => openEditor('knowledgeMode')}
                className={ROW_ACTION}
                aria-label={t('projects.knowledgeMode.change', 'Change knowledge mode')}
              >
                {t('projects.panel.change', 'Change')}
              </button>
            ) : null
          }
        >
          <p className="text-gray-600 dark:text-gray-400">
            {knowledgeModeLabel(t, project.knowledgeMode || 'auto')}
            {!project.knowledgeMode && ` ${t('projects.knowledgeMode.defaultSuffix', '(default)')}`}
          </p>
        </ProjectPanelRow>
      )}
      {showRefresh && (
        <ProjectPanelRow
          icon="clock"
          title={t('projects.refresh.rowTitle', 'Refresh')}
          titleId="project-refresh-title"
          action={
            editable ? (
              <button
                type="button"
                onClick={() => {
                  setMessage(null);
                  setSchedulingRefresh(true);
                }}
                className={ROW_ACTION}
                aria-label={t(
                  'projects.refresh.change',
                  'Change the refresh of files and web pages'
                )}
              >
                {t('projects.panel.change', 'Change')}
              </button>
            ) : null
          }
        >
          <p className="text-gray-600 dark:text-gray-400">
            {project.refreshTtl
              ? t('projects.refresh.projectValue', 'Files and web pages: {{ttl}}', {
                  ttl: refreshTtlLabel(project.refreshTtl, t)
                })
              : platformRefreshTtl
                ? t('projects.refresh.projectDefault', 'Files and web pages: {{ttl}} (default)', {
                    ttl: refreshTtlLabel(platformRefreshTtl, t)
                  })
                : t('projects.refresh.projectDefaultUnknown', 'Default of this installation')}
          </p>
          <p className="text-gray-600 dark:text-gray-400">
            {refreshModeLabel(project.refreshMode || platformRefreshMode, t)}
          </p>
        </ProjectPanelRow>
      )}
      {schedulingRefresh && (
        <RefreshTtlDialog
          scope="project"
          value={project.refreshTtl ?? null}
          inherited={platformRefreshTtl}
          mode={project.refreshMode ?? null}
          inheritedMode={platformRefreshMode}
          onClose={() => setSchedulingRefresh(false)}
          onSave={async changes => {
            const saved = await updateProject(project.id, changes);
            onSaved(saved);
            setMessage({ ok: true, text: t('projects.settings.saved', 'Saved.') });
            return true;
          }}
        />
      )}
      {/* Always in the page, so a screen reader announces the text when it
          arrives; "Saved." goes away again after a moment. */}
      <p
        role="status"
        className={`text-sm empty:hidden ${message?.ok ? 'px-4 py-2 text-green-700 dark:text-green-400' : ''}`}
      >
        {message?.ok && !editing ? message.text : ''}
      </p>

      {editable && (
        <Modal
          isOpen={editing}
          onClose={() => setEditing(false)}
          labelledBy="project-settings-title"
          maxWidthClassName="max-w-2xl"
          initialFocusRef={initialFocusRef}
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
                showKnowledgeMode={
                  project.ownership === 'user' && !String(project.id).startsWith('ifc_')
                }
                lockedFields={nameLocked ? ['name', 'description'] : []}
                lockedHint={t(
                  'projects.settings.collectionNameLocked',
                  'The name and the description are those of the smart collection, which cannot be changed from here on this installation. Change them in iFinder.'
                )}
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
