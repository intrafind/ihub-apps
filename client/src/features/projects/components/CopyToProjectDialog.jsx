// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { createProject, importProjectItems } from '../../../api';
import {
  invalidateProjectsConfig,
  invalidateProjectsList,
  useMyProjects,
  useProjectsConfig
} from '../hooks/useProjects';
import { projectErrorMessage } from '../utils/projectErrors';
import {
  buildCreateProjectBody,
  projectCreation,
  projectDisplayName,
  validateProjectForm
} from '../utils/projectView';
import {
  copyTargetProjects,
  importErrorMessage,
  importErrorSkipped,
  importSummary,
  projectAudienceLabel
} from '../utils/projectImport';
import ProjectRoleBadge from './ProjectRoleBadge';
import {
  HINT_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON
} from './item-dialog/dialogStyles';

/** The value of the "New project" choice. */
const NEW_PROJECT = '__new__';

/**
 * "Copy to project…" of a generated file: the caller picks one of their projects
 * they may change (owner or editor) — or names a new one — and the server copies
 * the file into it as a document (`POST /api/projects/{id}/items/_import` with
 * `source`). A ZIP archive is unpacked into one document per entry.
 *
 * Each project shows who will see what is added ("Only you", "N members",
 * "Everyone signed in"), since a project shares its documents with its members.
 *
 * The parent reports the outcome (`onCopied`) — a toast with the count, the
 * skipped entries and a link to the project — and closes the dialog.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {{kind: string, ref: Object}} props.source - What the server copies.
 * @param {string} props.fileName - Shown in the dialog.
 * @param {(outcome: {project: Object, summary: {added: number, skipped: Array<Object>}}) => void}
 *   props.onCopied
 * @returns {JSX.Element|null}
 */
export default function CopyToProjectDialog({ isOpen, onClose, source, fileName, onCopied }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const titleRef = useRef(null);
  const { projects, loading, error: loadError } = useMyProjects({ enabled: isOpen });
  const { config } = useProjectsConfig();
  const targets = useMemo(() => copyTargetProjects(projects), [projects]);
  const creation = projectCreation(config);
  const [choice, setChoice] = useState(null);
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // The project this dialog created: a retry after a failed copy reuses it.
  const [createdProject, setCreatedProject] = useState(null);

  // Until the user picks, the first project is chosen (or "New project" when there is none).
  const selected = choice ?? (targets[0]?.id || (creation.allowed ? NEW_PROJECT : null)) ?? null;
  const selectedProject = targets.find(project => project.id === selected) || null;
  const creatingNew = selected === NEW_PROJECT;

  const handleSubmit = async event => {
    event.preventDefault();
    if (submitting || !selected) return;
    setError(null);
    let project = selectedProject;
    if (creatingNew) {
      const errors = validateProjectForm({ name: newName });
      if (errors.name) {
        setNameError(
          errors.name === 'required'
            ? t('projects.import.nameRequired', 'Enter a name for the new project.')
            : t('projects.import.nameTooLong', 'The name is too long.')
        );
        return;
      }
      setNameError(null);
    }
    setSubmitting(true);
    try {
      if (creatingNew && createdProject) {
        project = createdProject;
      } else if (creatingNew) {
        project = await createProject(buildCreateProjectBody({ name: newName }));
        invalidateProjectsList();
        invalidateProjectsConfig();
        setCreatedProject(project);
      }
    } catch (err) {
      setError({ message: projectErrorMessage(err, t), skipped: [] });
      setSubmitting(false);
      return;
    }
    try {
      const result = await importProjectItems(project.id, { source });
      onCopied({ project, summary: importSummary(result) });
    } catch (err) {
      // The server's `detail` says what was wrong with the file (415, 413); a refused
      // archive also lists what it skipped and why.
      setError({ message: importErrorMessage(err, t), skipped: importErrorSkipped(err) });
      setSubmitting(false);
    }
  };

  const radioClass = 'mt-1 h-4 w-4 text-indigo-600 border-gray-300 focus:ring-indigo-500';
  const audienceLine = project => (
    <span className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      <Icon name="user-group" size="xs" className="flex-none" />
      {t('projects.import.whoSees', 'Who sees it: {{audience}}', {
        audience: projectAudienceLabel(project, t)
      })}
    </span>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? () => {} : onClose}
      labelledBy={titleId}
      initialFocusRef={titleRef}
      zIndexClassName="z-[70]"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-col" data-testid="copy-to-project">
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div className="min-w-0">
            <h2
              id={titleId}
              ref={titleRef}
              tabIndex={-1}
              className="text-lg font-semibold text-gray-900 outline-hidden dark:text-gray-100"
            >
              {t('projects.import.title', 'Copy to project')}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'projects.import.subtitle',
                'A copy of “{{name}}” is added to the project as a document. It stays there when this chat is deleted.',
                { name: fileName }
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label={t('common.close', 'Close')}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto px-6 py-4">
          {loading && targets.length === 0 ? (
            <p role="status" className="text-sm text-gray-500 dark:text-gray-400">
              {t('projects.import.loading', 'Loading your projects…')}
            </p>
          ) : loadError && targets.length === 0 ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {projectErrorMessage(loadError, t)}
            </p>
          ) : targets.length === 0 && !creation.allowed ? (
            <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="copy-no-projects">
              {t(
                'projects.import.noProjects',
                'You have no project you can add documents to. Ask the owner of a project to make you an editor.'
              )}
            </p>
          ) : (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('projects.import.choose', 'Project')}
              </legend>
              <ul className="space-y-1">
                {targets.map(project => (
                  <li key={project.id}>
                    <label
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${
                        selected === project.id
                          ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-900/20'
                          : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`${baseId}-project`}
                        value={project.id}
                        checked={selected === project.id}
                        onChange={() => setChoice(project.id)}
                        className={radioClass}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                            {projectDisplayName(project, language)}
                          </span>
                          <ProjectRoleBadge project={project} />
                        </span>
                        {audienceLine(project)}
                      </span>
                    </label>
                  </li>
                ))}
                {creation.allowed && (
                  <li>
                    <label
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${
                        creatingNew
                          ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-900/20'
                          : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`${baseId}-project`}
                        value={NEW_PROJECT}
                        checked={creatingNew}
                        onChange={() => setChoice(NEW_PROJECT)}
                        className={radioClass}
                        data-testid="copy-new-project"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                          <Icon name="plus" size="xs" />
                          {t('projects.import.newProject', 'New project')}
                        </span>
                        {creatingNew && audienceLine(null)}
                      </span>
                    </label>
                    {creatingNew && (
                      <div className="mt-2 pl-10">
                        <label htmlFor={`${baseId}-name`} className="sr-only">
                          {t('projects.import.newProjectName', 'Name of the new project')}
                        </label>
                        <input
                          id={`${baseId}-name`}
                          type="text"
                          value={newName}
                          onChange={event => setNewName(event.target.value)}
                          placeholder={t(
                            'projects.import.newProjectName',
                            'Name of the new project'
                          )}
                          aria-invalid={nameError ? 'true' : undefined}
                          aria-describedby={nameError ? `${baseId}-name-error` : undefined}
                          className={INPUT_CLASS}
                          data-testid="copy-new-project-name"
                        />
                        {nameError && (
                          <p
                            id={`${baseId}-name-error`}
                            role="alert"
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                          >
                            {nameError}
                          </p>
                        )}
                        <p className={HINT_CLASS}>
                          {t(
                            'projects.import.newProjectHint',
                            'It stays private until you share it.'
                          )}
                        </p>
                      </div>
                    )}
                  </li>
                )}
              </ul>
            </fieldset>
          )}
          {error && (
            <div role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
              <p>{error.message}</p>
              {error.skipped.length > 0 && (
                <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                  {error.skipped.map(entry => (
                    <li key={`${entry.name}:${entry.code}`} className="break-words">
                      {entry.message
                        ? t('projects.import.skippedEntry', '{{name}}: {{reason}}', {
                            name: entry.name,
                            reason: entry.message
                          })
                        : entry.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className={SECONDARY_BUTTON}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            disabled={submitting || !selected}
            aria-busy={submitting || undefined}
            className={PRIMARY_BUTTON}
            data-testid="copy-to-project-submit"
          >
            {submitting
              ? t('projects.import.copying', 'Copying…')
              : t('projects.import.submit', 'Copy')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
