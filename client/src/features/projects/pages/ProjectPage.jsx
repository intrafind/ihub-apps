// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { deleteProject } from '../../../api';
import ProjectChatComposer from '../components/ProjectChatComposer';
import ProjectChatsSection from '../components/ProjectChatsSection';
import ProjectItemsSection from '../components/ProjectItemsSection';
import ProjectMembersSection from '../components/ProjectMembersSection';
import ProjectRoleBadge, { ProjectAudienceBadges } from '../components/ProjectRoleBadge';
import ProjectCatalogCard from '../components/ProjectCatalogCard';
import ProjectSettingsCard from '../components/ProjectSettingsCard';
import { PANEL_CARD } from '../components/ProjectPanelRow';
import {
  invalidateProjectsConfig,
  invalidateProjectsList,
  useProject,
  useProjectsAvailability,
  useProjectsConfig
} from '../hooks/useProjects';
import { projectErrorMessage } from '../utils/projectErrors';
import { localizedText } from '../utils/projectItems';
import { projectDisplayName } from '../utils/projectView';

/**
 * The banner of a project whose owner is gone (spec 1 §7.1): members keep
 * reading it, nobody changes it until an admin hands it over.
 *
 * @returns {JSX.Element}
 */
function ReadOnlyBanner() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
      data-testid="project-read-only"
    >
      <Icon name="lock" size="sm" className="mt-0.5 flex-none" />
      <p>
        {t(
          'projects.page.readOnly',
          'The owner of this project is no longer active. It stays readable, but nobody can change it until an administrator transfers it.'
        )}
      </p>
    </div>
  );
}

/**
 * `/projects/:projectId` — one project (#1036): its name, description and
 * instructions, a field to start a chat in it, its documents with their
 * status and the quotas, its chats, and its members. What can be changed follows the `permissions` the server
 * sent; admin projects (reached through an app) are shown read-only here and
 * managed in the admin pages.
 *
 * React Router keeps the page mounted when only `:projectId` changes (Back,
 * Forward, a link to another project). The content is remounted per project
 * instead: an answer to a save, an upload or a member change still out for
 * the previous project then lands in a component that is gone, rather than
 * replacing the project now on screen — whose documents and delete action
 * would otherwise target the previous project under the new URL.
 *
 * @returns {JSX.Element}
 */
export default function ProjectPage() {
  const { projectId } = useParams();
  return <ProjectPageContent key={projectId} projectId={projectId} />;
}

/**
 * One project's page; mounted for a single project id.
 *
 * @param {Object} props
 * @param {string} props.projectId
 * @returns {JSX.Element}
 */
function ProjectPageContent({ projectId }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const navigate = useNavigate();
  const { userId } = useProjectsAvailability();
  const { config } = useProjectsConfig();
  const { project, setProject, loading, error, reload } = useProject(projectId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const backToList = notice => {
    invalidateProjectsList();
    invalidateProjectsConfig();
    navigate('/projects', { replace: true, ...(notice ? { state: { notice } } : {}) });
  };

  const handleDelete = async () => {
    setConfirmDelete(false);
    setDeleteError(null);
    try {
      await deleteProject(project.id);
      backToList();
    } catch (err) {
      setDeleteError(projectErrorMessage(err, t));
    }
  };

  // Always back to the list, saying what happened: the caller is no longer
  // the owner. A share that still reaches them (a group, everyone) keeps the
  // project under "Shared with me", which the message explains; a full
  // admin's compliance view of every project does not count as keeping it.
  const handleTransferred = (result, newOwner) => {
    const done = t('projects.transfer.done', '“{{project}}” now belongs to {{name}}.', {
      project: projectDisplayName(project, language),
      name: newOwner?.name || result?.owner?.name || ''
    });
    const stillMember = result?.role === 'editor' || result?.role === 'user';
    backToList(
      stillMember
        ? `${done} ${t(
            'projects.transfer.doneStillShared',
            'You still see it under “Shared with me”, because a share reaches you.'
          )}`
        : done
    );
  };

  if (loading && !project) {
    return <p className="p-8 text-sm text-gray-500">{t('common.loading', 'Loading…')}</p>;
  }

  if (!project) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10 text-center">
        <Icon name="folder-open" size="xl" className="mx-auto text-gray-500" />
        <p role="alert" className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {error ||
            t(
              'projects.errors.notFound',
              'This project does not exist or you no longer have access to it.'
            )}
        </p>
        <Link to="/projects" className="mt-4 inline-block text-sm text-indigo-600 hover:underline">
          {t('projects.page.backToList', 'All projects')}
        </Link>
      </div>
    );
  }

  const permissions = project.permissions || {};
  const isUserProject = project.ownership === 'user';
  const editable = isUserProject && permissions.canEdit === true && !permissions.readOnly;
  const readOnlyOwnerGone =
    isUserProject && (permissions.readOnly === true || project.owner?.active === false);
  const description = localizedText(project.description, language);

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900 px-4 sm:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        <nav aria-label={t('projects.page.breadcrumb', 'Breadcrumb')} className="text-sm">
          <Link to="/projects" className="text-indigo-600 dark:text-indigo-400 hover:underline">
            {t('projects.list.title', 'Projects')}
          </Link>
        </nav>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 break-words">
                {projectDisplayName(project, language)}
              </h1>
              <ProjectRoleBadge project={project} />
              <ProjectAudienceBadges project={project} />
            </div>
            {description && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isUserProject && permissions.canDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30"
              >
                <Icon name="trash" size="sm" />
                {t('projects.page.delete', 'Delete project')}
              </button>
            )}
          </div>
        </div>

        {readOnlyOwnerGone && <ReadOnlyBanner />}
        {project.ownership === 'admin' && (
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'projects.page.adminProject',
              'This project comes with one of your apps. Administrators manage it.'
            )}
          </p>
        )}
        {(error || deleteError) && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300"
          >
            {deleteError || error}
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6 min-w-0">
            {/* The main thing to do with a project: chat with its documents. Someone
                who took it from the catalog starts a chat outside it, with it attached. */}
            {isUserProject && !readOnlyOwnerGone && (
              <ProjectChatComposer
                project={project}
                projectName={projectDisplayName(project, language)}
                attach={permissions.canHoldChats === false}
              />
            )}
            {/* Chats before the documents: a long document list must not push them out of sight.
                Someone from the catalog holds no chats here: theirs attach the project. */}
            {permissions.canHoldChats !== false && <ProjectChatsSection project={project} />}
            <ProjectItemsSection
              project={project}
              config={config}
              editable={editable}
              setProject={setProject}
              reload={reload}
            />
          </div>
          {/* The side panel: one card of compact rows; editing opens a dialog. */}
          <div className={`${PANEL_CARD} self-start min-w-0`} data-testid="project-side-panel">
            <ProjectSettingsCard
              project={project}
              editable={editable}
              onSaved={saved => {
                setProject(saved);
                // The list and the chats' project labels show the name too.
                invalidateProjectsList();
              }}
            />
            {isUserProject && (
              <ProjectMembersSection
                project={project}
                userId={userId}
                onChanged={saved => {
                  setProject(saved);
                  invalidateProjectsList();
                }}
                onTransferred={handleTransferred}
                onLeft={backToList}
              />
            )}
            {isUserProject && (
              <ProjectCatalogCard
                project={project}
                config={config}
                onChanged={() => {
                  // Read again: the answer carries no link states of the documents.
                  void reload();
                  invalidateProjectsList();
                }}
              />
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        title={t('projects.page.deleteTitle', 'Delete project')}
        message={t(
          'projects.page.deleteConfirm',
          'Delete “{{name}}” and all its documents? Its chats are kept, outside the project. This cannot be undone.',
          { name: projectDisplayName(project, language) }
        )}
        confirmLabel={t('common.delete', 'Delete')}
        danger
        onConfirm={handleDelete}
        onDeny={() => setConfirmDelete(false)}
      />
    </div>
  );
}
