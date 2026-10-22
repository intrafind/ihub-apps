// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  estimateAdminProject,
  fetchAdminProjectDependencies,
  fetchAdminProjectItemText,
  fetchAdminProjectKinds,
  getAdminApiErrorMessage,
  testAdminProject,
  updateAdminProjectItemText
} from '../../../api/adminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import ChangeHistoryDrawer from '../components/ChangeHistoryDrawer';
import ProjectTestResults from '../components/ProjectTestResults';
import EstimateTokensButton from '../../projects/components/EstimateTokensButton';
import ProjectEstimatePanel from '../../projects/components/ProjectEstimatePanel';
import ProjectItemsTable from '../../projects/components/ProjectItemsTable';
import ProjectItemTextDialog from '../../projects/components/ProjectItemTextDialog';
import { useProjectEstimate } from '../../projects/hooks/useProjectEstimate';
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
function Card({ title, children }) {
  return (
    <section className="bg-white dark:bg-gray-800 rounded-lg shadow-xs p-6">
      <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-3">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Admin → Projects → one project (read-only). The name of a project in the
 * list opens this view: its description and instructions, its items with the
 * text preview (whose text an admin can edit there), what links it, and the checks (test, token estimate). **Edit**
 * leads to the form.
 *
 * @returns {JSX.Element}
 */
function AdminProjectViewPage() {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const { id } = useParams();
  const navigate = useNavigate();
  const { project, setProject, loading, error: loadError } = useAdminProject(id);
  const [kinds, setKinds] = useState([]);
  const [dependencies, setDependencies] = useState([]);
  const [previewItem, setPreviewItem] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const estimateCall = useCallback(() => estimateAdminProject(id), [id]);
  const {
    estimate,
    byItem,
    loading: estimating,
    error: estimateError,
    run: runEstimate,
    clear: clearEstimate
  } = useProjectEstimate(estimateCall, adminErrorMessage);

  useEffect(() => {
    fetchAdminProjectKinds()
      .then(setKinds)
      .catch(err => console.error('Failed to load item kinds:', err));
    fetchAdminProjectDependencies(id)
      .then(setDependencies)
      .catch(err => console.error('Failed to load project links:', err));
  }, [id]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testAdminProject(id));
    } catch (err) {
      setTestResult({
        success: false,
        duration: 0,
        items: [],
        error: getAdminApiErrorMessage(err)
      });
    } finally {
      setTesting(false);
    }
  };

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
  const description = localizedText(project.description, language);
  const enabled = project.enabled !== false;
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
              <span
                className={`px-2 py-1 text-xs font-medium rounded-full ${
                  enabled
                    ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                    : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
                }`}
              >
                {enabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
              </span>
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">{project.id}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              {t('admin.projects.history', 'History')}
            </button>
            <EstimateTokensButton loading={estimating} onClick={runEstimate} />
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium flex items-center"
            >
              <Icon
                name={testing ? 'arrow-path' : 'beaker'}
                className={`h-4 w-4 mr-2 ${testing ? 'animate-spin' : ''}`}
              />
              {testing
                ? t('admin.projects.test.running', 'Testing...')
                : t('admin.projects.test.button', 'Test')}
            </button>
            <Link
              to={`/admin/projects/${encodeURIComponent(project.id)}/edit`}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium flex items-center"
            >
              <Icon name="pencil" className="h-4 w-4 mr-2" />
              {t('admin.projects.view.edit', 'Edit')}
            </Link>
          </div>
        </div>

        {estimateError && (
          <div
            role="alert"
            className="mb-6 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-800 dark:text-red-200"
          >
            {t('projects.estimate.failed', 'The estimate could not be made.')} {estimateError}
          </div>
        )}

        <div className="space-y-6">
          {estimate && <ProjectEstimatePanel estimate={estimate} onDismiss={clearEstimate} />}
          {testResult && (
            <ProjectTestResults result={testResult} onDismiss={() => setTestResult(null)} />
          )}

          <Card title={t('admin.projects.fields.description', 'Description')}>
            {description ? (
              <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                {description}
              </p>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('admin.projects.view.noDescription', 'No description.')}
              </p>
            )}
            {(project.category || (project.tags || []).length > 0) && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {project.category && (
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    {project.category}
                  </span>
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
          </Card>

          <Card title={t('admin.projects.fields.instructions', 'Instructions')}>
            {project.instructions ? (
              <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-sans">
                {project.instructions}
              </pre>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('admin.projects.view.noInstructions', 'No instructions.')}
              </p>
            )}
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.projects.view.instructionsHint',
                'The instructions are added to the system prompt of every app, workflow step or agent that links this project.'
              )}
            </p>
          </Card>

          <Card title={t('admin.projects.items.title', 'Items')}>
            <ProjectItemsTable
              items={project.items || []}
              kinds={kinds}
              readOnly
              estimates={estimate ? byItem : undefined}
              onPreview={setPreviewItem}
            />
          </Card>

          <Card title={t('admin.projects.view.usedBy', 'Used by')}>
            {dependencies.length === 0 ? (
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
        </div>
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
      <ChangeHistoryDrawer
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        resource="project"
        resourceId={id}
      />
    </div>
  );
}

export default AdminProjectViewPage;
