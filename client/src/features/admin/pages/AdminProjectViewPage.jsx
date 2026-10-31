// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  fetchAdminProjectDependencies,
  fetchAdminProjectConfig,
  fetchAdminProjectItemText,
  fetchAdminProjectKinds,
  getAdminApiErrorMessage,
  updateAdminProjectItemText
} from '../../../api/adminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import ChangeHistoryDrawer from '../components/ChangeHistoryDrawer';
import {
  AdminProjectCheckResults,
  AdminProjectHeaderActions,
  FILLED_HEADER_BUTTON,
  ProjectDetailLayout,
  useAdminProjectChecks
} from '../components/AdminProjectDetail';
import AddProjectItemDialog from '../../projects/components/AddProjectItemDialog';
import ProjectItemsTable from '../../projects/components/ProjectItemsTable';
import { useProjectItemDocumentActions } from '../../projects/components/ProjectItemDocumentActions';
import ProjectItemTextDialog from '../../projects/components/ProjectItemTextDialog';
import AdminProjectSettingsPanel from '../components/AdminProjectSettingsPanel';
import { ADMIN_ITEM_API } from '../utils/adminProjectItemApi';
import { useAdminProject } from '../hooks/useAdminProject';
import { localizedText } from '../../projects/utils/projectItems';

/** Where the admin edits each kind of resource that links a project. */
const DEPENDENCY_LINKS = {
  app: id => `/admin/apps/${encodeURIComponent(id)}`,
  workflow: id => `/admin/workflows/${encodeURIComponent(id)}`,
  agent: id => `/admin/agents/${encodeURIComponent(id)}`
};

const fetchAdminItemText = (...args) => fetchAdminProjectItemText(...args);
const adminErrorMessage = err => getAdminApiErrorMessage(err);

/** One labelled block of the view. */
function Card({ title, action, children }) {
  return (
    <section className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Admin → Projects → one project. The name of a project in the list opens
 * this view: its items with the text preview (whose text an admin can edit
 * there), what links it, the checks (test, token estimate), and its
 * settings beside them, each changed in place in a dialog. **Edit items**
 * leads to the page that pins, refreshes, moves and removes items.
 *
 * @returns {JSX.Element}
 */
function AdminProjectViewPageContent({ id }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const navigate = useNavigate();
  const { project, setProject, loading, error: loadError, reload } = useAdminProject(id);
  const [kinds, setKinds] = useState([]);
  const [config, setConfig] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  // `null` until the lookup answered; an error is not an empty list.
  const [dependencies, setDependencies] = useState(null);
  const [dependenciesFailed, setDependenciesFailed] = useState(false);
  const [previewItem, setPreviewItem] = useState(null);
  const documentActions = useProjectItemDocumentActions(id);
  const [historyOpen, setHistoryOpen] = useState(false);
  const checks = useAdminProjectChecks(id);
  const { estimate, byItem, clearEstimate } = checks;

  useEffect(() => {
    fetchAdminProjectKinds()
      .then(setKinds)
      .catch(err => console.error('Failed to load item kinds:', err));
    fetchAdminProjectConfig()
      .then(setConfig)
      .catch(err => console.error('Failed to load project settings:', err));
    setDependenciesFailed(false);
    fetchAdminProjectDependencies(id)
      .then(setDependencies)
      .catch(err => {
        console.error('Failed to load project links:', err);
        setDependenciesFailed(true);
      });
  }, [id]);

  if (loading && !project) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-center h-64">
          <Icon name="arrow-path" className="animate-spin h-8 w-8 text-gray-500" />
          <span className="ml-3 text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </span>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-3xl mx-auto py-12 px-4 text-center">
          <Icon name="x-circle" className="h-12 w-12 text-red-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            {t('admin.projects.notFound', 'Project not found')}
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4">{loadError}</p>
          <button
            type="button"
            onClick={() => navigate('/admin/projects')}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium"
          >
            {t('admin.projects.backToList', 'Back to projects')}
          </button>
        </div>
      </div>
    );
  }

  const title = localizedText(project.name, language) || project.id;
  const typeLabels = {
    app: t('admin.projects.dependencies.types.app', 'App'),
    workflow: t('admin.projects.dependencies.types.workflow', 'Workflow'),
    agent: t('admin.projects.dependencies.types.agent', 'Agent')
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto py-6 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: t('admin.nav.overview', 'Overview'), href: '/admin' },
            { label: t('admin.nav.projects', 'Projects'), href: '/admin/projects' },
            { label: title }
          ]}
        />

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2 flex-wrap">
              <Icon name="folder" className="h-6 w-6" />
              <span className="break-words">{title}</span>
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">{project.id}</p>
          </div>
          <AdminProjectHeaderActions checks={checks} onHistory={() => setHistoryOpen(true)}>
            <Link
              to={`/admin/projects/${encodeURIComponent(project.id)}/edit`}
              className={FILLED_HEADER_BUTTON}
            >
              <Icon name="pencil" className="h-4 w-4 mr-2" />
              {t('admin.projects.view.editItems', 'Edit items')}
            </Link>
          </AdminProjectHeaderActions>
        </div>

        {/* The same layout as a user's project page: the documents in the wide
            column, the settings as rows beside them, each changed in a dialog. */}
        <ProjectDetailLayout
          main={
            <>
              <AdminProjectCheckResults checks={checks} />

              <Card
                title={t('admin.projects.items.title', 'Items')}
                action={
                  <button
                    type="button"
                    onClick={() => setAddOpen(true)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium flex items-center"
                  >
                    <Icon name="plus" className="h-4 w-4 mr-2" />
                    {t('admin.projects.items.add', 'Add item')}
                  </button>
                }
              >
                <ProjectItemsTable
                  items={project.items || []}
                  kinds={kinds}
                  readOnly
                  estimates={estimate ? byItem : undefined}
                  onPreview={setPreviewItem}
                  onDocumentAction={documentActions.onDocumentAction}
                />
                {documentActions.error && (
                  <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
                    {documentActions.error}
                  </p>
                )}
                {documentActions.dialogs}
              </Card>

              <Card title={t('admin.projects.view.usedBy', 'Used by')}>
                {dependenciesFailed ? (
                  <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                    {t(
                      'admin.projects.view.usedByFailed',
                      'The apps, workflows and agents that link this project could not be loaded.'
                    )}
                  </p>
                ) : dependencies === null ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('common.loading', 'Loading...')}
                  </p>
                ) : dependencies.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.projects.view.notLinked',
                      'No app, workflow or agent links this project.'
                    )}
                  </p>
                ) : (
                  <ul className="space-y-2" data-testid="project-dependencies">
                    {dependencies.map(dependency => {
                      const href = DEPENDENCY_LINKS[dependency.type]?.(dependency.id);
                      const label = dependency.name || dependency.id;
                      return (
                        <li
                          key={`${dependency.type}:${dependency.id}:${dependency.nodeId || ''}`}
                          className="flex items-center gap-2 text-sm"
                        >
                          <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                            {typeLabels[dependency.type] || dependency.type}
                          </span>
                          {href ? (
                            <Link
                              to={href}
                              className="text-indigo-600 dark:text-indigo-400 hover:underline truncate"
                            >
                              {label}
                            </Link>
                          ) : (
                            <span className="truncate">{label}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </>
          }
          side={<AdminProjectSettingsPanel project={project} onSaved={setProject} />}
        />
      </div>

      <ProjectItemTextDialog
        projectId={id}
        item={previewItem}
        onClose={() => setPreviewItem(null)}
        fetchText={fetchAdminItemText}
        onSave={async text => {
          const updated = await updateAdminProjectItemText(id, previewItem.id, text);
          // The stored text changed: the item's size and the estimate are old.
          if (updated) {
            setProject(prev =>
              prev
                ? {
                    ...prev,
                    items: (prev.items || []).map(entry =>
                      entry.id === updated.id ? updated : entry
                    )
                  }
                : prev
            );
            clearEstimate();
          }
          return updated;
        }}
        errorMessage={adminErrorMessage}
      />
      {addOpen && kinds.length > 0 && (
        <AddProjectItemDialog
          isOpen
          onClose={() => setAddOpen(false)}
          projectId={id}
          kinds={kinds}
          config={config}
          api={ADMIN_ITEM_API}
          project={project}
          onAdded={() => {
            // The items changed: an estimate of the old set no longer holds.
            clearEstimate();
            void reload();
          }}
        />
      )}
      <ChangeHistoryDrawer
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        resource="project"
        readOnly
        resourceId={id}
      />
    </div>
  );
}

/**
 * The view of the project in the URL. Mounted per id, so the links, the test
 * result and the estimate of one project never show under another.
 *
 * @returns {JSX.Element}
 */
function AdminProjectViewPage() {
  const { id } = useParams();
  return <AdminProjectViewPageContent key={id} id={id} />;
}

export default AdminProjectViewPage;
