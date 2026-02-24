import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import {
  fetchAdminSkillDetail,
  updateSkill,
  toggleSkill,
  deleteSkill,
  exportSkill
} from '../../../api/adminApi';

/**
 * AdminSkillEditPage - Detail / edit page for a single installed skill.
 *
 * Displays skill metadata (name, displayName, description, license,
 * compatibility, author, version), its SKILL.md body rendered as HTML,
 * a file list, an enabled/disabled toggle, configuration overrides,
 * and export / delete actions.
 *
 * Route: /admin/skills/:skillName
 *
 * Follows the same layout conventions as AdminToolEditPage.
 */
const AdminSkillEditPage = () => {
  const { t } = useTranslation();
  const { skillName } = useParams();
  const navigate = useNavigate();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [skill, setSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  /** Local overrides the admin can change (e.g. custom description). */
  const [overrides, setOverrides] = useState({
    description: ''
  });

  /** Active tab for organizing content sections. */
  const [activeTab, setActiveTab] = useState('overview'); // overview | files | config

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  useEffect(() => {
    loadSkill();
  }, [skillName]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Loads the full skill detail from the admin API and populates local state.
   */
  const loadSkill = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminSkillDetail(skillName);
      setSkill(data);

      // Pre-populate override fields from existing config overrides
      setOverrides({
        description: data.configOverrides?.description || data.description || ''
      });
    } catch (err) {
      console.error('Error loading skill:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Toggles the skill between enabled and disabled, then reloads.
   */
  const handleToggle = async () => {
    try {
      setError(null);
      await toggleSkill(skillName);
      await loadSkill();
    } catch (err) {
      setError(err.message);
    }
  };

  /**
   * Persists the configuration overrides to the server.
   */
  const handleSaveOverrides = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);
      await updateSkill(skillName, { configOverrides: overrides });
      setSuccessMessage(t('admin.skills.saveSuccess', 'Skill configuration saved successfully'));
      await loadSkill();
    } catch (err) {
      console.error('Error saving skill overrides:', err);
      setError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Exports the skill as a downloadable .zip archive.
   */
  const handleExport = () => {
    try {
      exportSkill(skillName);
    } catch (err) {
      setError(`Failed to export skill: ${err.message}`);
    }
  };

  /**
   * Deletes the skill after user confirmation, then navigates back to the list.
   */
  const handleDelete = async () => {
    if (!confirm(t('admin.skills.deleteConfirm', 'Are you sure you want to delete this skill?'))) {
      return;
    }

    try {
      await deleteSkill(skillName);
      navigate('/admin/skills');
    } catch (err) {
      console.error('Error deleting skill:', err);
      setError(err.message || 'Failed to delete skill');
    }
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Renders a SKILL.md body string as sanitised HTML via `marked`.
   *
   * @param {string} markdown - Raw markdown content
   * @returns {string} HTML string
   */
  const renderMarkdown = markdown => {
    if (!markdown) return '';
    try {
      return marked(markdown);
    } catch {
      return `<pre>${markdown}</pre>`;
    }
  };

  // ---------------------------------------------------------------------------
  // Render: loading
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
        </div>
      </AdminAuth>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: fatal error (skill could not be loaded at all)
  // ---------------------------------------------------------------------------

  if (!skill) {
    return (
      <AdminAuth>
        <div>
          <AdminNavigation />
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
              <div className="flex">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
                    {t('admin.skills.notFound', 'Skill not found')}
                  </h3>
                  <p className="mt-1 text-sm text-red-700 dark:text-red-400">
                    {error ||
                      t(
                        'admin.skills.notFoundDescription',
                        'The requested skill could not be loaded.'
                      )}
                  </p>
                  <button
                    onClick={() => navigate('/admin/skills')}
                    className="mt-2 text-sm text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                  >
                    {t('admin.skills.backToList', 'Back to Skills')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </AdminAuth>
    );
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const metadata = skill.metadata || {};
  const files = skill.files || [];
  const compatibility = skill.compatibility || {};
  const isEnabled = skill.enabled !== false;

  // ---------------------------------------------------------------------------
  // Render: main page
  // ---------------------------------------------------------------------------

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Page header */}
          <div className="md:flex md:items-center md:justify-between mb-6">
            <div className="flex-1 min-w-0">
              <div className="flex items-center">
                <div className="h-10 w-10 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center mr-4">
                  <Icon name="sparkles" className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                    {skill.displayName || skill.name}
                  </h1>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{skill.name}</p>
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 md:mt-0 md:ml-4">
              {/* Back */}
              <button
                onClick={() => navigate('/admin/skills')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                {t('common.back', 'Back')}
              </button>

              {/* Toggle enabled/disabled */}
              <button
                onClick={handleToggle}
                className={`inline-flex items-center px-4 py-2 border rounded-md shadow-sm text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                  isEnabled
                    ? 'border-red-300 text-red-700 bg-white hover:bg-red-50 dark:border-red-600 dark:text-red-400 dark:bg-gray-800 dark:hover:bg-red-900/30 focus:ring-red-500'
                    : 'border-green-300 text-green-700 bg-white hover:bg-green-50 dark:border-green-600 dark:text-green-400 dark:bg-gray-800 dark:hover:bg-green-900/30 focus:ring-green-500'
                }`}
              >
                <Icon name={isEnabled ? 'eye-slash' : 'eye'} className="h-4 w-4 mr-2" />
                {isEnabled
                  ? t('admin.skills.disable', 'Disable')
                  : t('admin.skills.enable', 'Enable')}
              </button>

              {/* Export */}
              <button
                onClick={handleExport}
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="download" className="h-4 w-4 mr-2" />
                {t('admin.skills.export', 'Export')}
              </button>

              {/* Delete */}
              <button
                onClick={handleDelete}
                className="inline-flex items-center px-4 py-2 border border-red-300 dark:border-red-600 rounded-md shadow-sm text-sm font-medium text-red-700 dark:text-red-400 bg-white dark:bg-gray-800 hover:bg-red-50 dark:hover:bg-red-900/30 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
              >
                <Icon name="trash" className="h-4 w-4 mr-2" />
                {t('admin.skills.delete', 'Delete')}
              </button>
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div className="mb-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
              <div className="flex">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                <div className="ml-3 flex-1">
                  <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
                    {t('common.error', 'Error')}
                  </h3>
                  <p className="mt-1 text-sm text-red-700 dark:text-red-400">{error}</p>
                </div>
                <button
                  onClick={() => setError(null)}
                  className="ml-3 text-red-400 hover:text-red-600"
                >
                  <Icon name="close" className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Success banner */}
          {successMessage && (
            <div className="mb-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md p-4">
              <div className="flex">
                <Icon name="check-circle" className="h-5 w-5 text-green-400" />
                <div className="ml-3 flex-1">
                  <p className="text-sm text-green-700 dark:text-green-400">{successMessage}</p>
                </div>
                <button
                  onClick={() => setSuccessMessage(null)}
                  className="ml-3 text-green-400 hover:text-green-600"
                >
                  <Icon name="close" className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Status badge */}
          <div className="mb-6">
            <span
              className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                isEnabled
                  ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              <Icon name={isEnabled ? 'check-circle' : 'minus-circle'} className="h-4 w-4 mr-1.5" />
              {isEnabled
                ? t('admin.skills.enabled', 'Enabled')
                : t('admin.skills.disabled', 'Disabled')}
            </span>
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-200 dark:border-gray-700 mb-6">
            <nav className="-mb-px flex space-x-8">
              <button
                onClick={() => setActiveTab('overview')}
                className={`${
                  activeTab === 'overview'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
              >
                <Icon name="information-circle" className="h-4 w-4 inline mr-2" />
                {t('admin.skills.tabs.overview', 'Overview')}
              </button>
              <button
                onClick={() => setActiveTab('files')}
                className={`${
                  activeTab === 'files'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
              >
                <Icon name="folder" className="h-4 w-4 inline mr-2" />
                {t('admin.skills.tabs.files', 'Files')}
                {files.length > 0 && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                    {files.length}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveTab('config')}
                className={`${
                  activeTab === 'config'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
              >
                <Icon name="cog" className="h-4 w-4 inline mr-2" />
                {t('admin.skills.tabs.configuration', 'Configuration')}
              </button>
            </nav>
          </div>

          {/* ================================================================ */}
          {/*  TAB: Overview                                                   */}
          {/* ================================================================ */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Metadata card */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                  <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                    {t('admin.skills.metadata', 'Skill Metadata')}
                  </h2>
                </div>
                <div className="px-6 py-4">
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                    {/* Name */}
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t('admin.skills.field.name', 'Name')}
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                        {skill.name}
                      </dd>
                    </div>

                    {/* Display name */}
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t('admin.skills.field.displayName', 'Display Name')}
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                        {skill.displayName || '-'}
                      </dd>
                    </div>

                    {/* Description */}
                    <div className="sm:col-span-2">
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t('admin.skills.field.description', 'Description')}
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                        {skill.description || '-'}
                      </dd>
                    </div>

                    {/* Author */}
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t('admin.skills.field.author', 'Author')}
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                        {metadata.author || '-'}
                      </dd>
                    </div>

                    {/* Version */}
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t('admin.skills.field.version', 'Version')}
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                        {metadata.version ? (
                          <code className="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
                            {metadata.version}
                          </code>
                        ) : (
                          '-'
                        )}
                      </dd>
                    </div>

                    {/* License */}
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t('admin.skills.field.license', 'License')}
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                        {skill.license || '-'}
                      </dd>
                    </div>

                    {/* Compatibility */}
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                        {t('admin.skills.field.compatibility', 'Compatibility')}
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                        {compatibility.minVersion || compatibility.maxVersion ? (
                          <span>
                            {compatibility.minVersion && (
                              <span>
                                {t('admin.skills.field.minVersion', 'Min')}:{' '}
                                {compatibility.minVersion}
                              </span>
                            )}
                            {compatibility.minVersion && compatibility.maxVersion && ' / '}
                            {compatibility.maxVersion && (
                              <span>
                                {t('admin.skills.field.maxVersion', 'Max')}:{' '}
                                {compatibility.maxVersion}
                              </span>
                            )}
                          </span>
                        ) : (
                          '-'
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              {/* SKILL.md content */}
              {skill.body && (
                <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                    <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                      {t('admin.skills.documentation', 'Documentation (SKILL.md)')}
                    </h2>
                  </div>
                  <div className="px-6 py-4">
                    <div
                      className="prose dark:prose-invert max-w-none text-sm"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(skill.body) }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================================================================ */}
          {/*  TAB: Files                                                      */}
          {/* ================================================================ */}
          {activeTab === 'files' && (
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.skills.fileList', 'Skill Files')}
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.skills.fileListDescription',
                    'References, scripts, and assets included in this skill package.'
                  )}
                </p>
              </div>

              {files.length > 0 ? (
                <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                  {files.map((file, index) => {
                    const fileName =
                      typeof file === 'string' ? file : file.name || file.path || String(file);
                    const fileType = typeof file === 'object' ? file.type : null;

                    return (
                      <li key={index} className="px-6 py-3 flex items-center justify-between">
                        <div className="flex items-center min-w-0">
                          <Icon
                            name={
                              fileType === 'script'
                                ? 'code'
                                : fileType === 'asset'
                                  ? 'photograph'
                                  : 'document-text'
                            }
                            className="h-5 w-5 text-gray-400 dark:text-gray-500 mr-3 flex-shrink-0"
                          />
                          <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                            {fileName}
                          </span>
                        </div>
                        {fileType && (
                          <span className="ml-4 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                            {fileType}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="text-center py-12">
                  <Icon
                    name="folder"
                    className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
                  />
                  <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t('admin.skills.noFiles', 'No files')}
                  </h3>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.skills.noFilesDescription',
                      'This skill does not contain any listed files.'
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ================================================================ */}
          {/*  TAB: Configuration overrides                                    */}
          {/* ================================================================ */}
          {activeTab === 'config' && (
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.skills.configOverrides', 'Configuration Overrides')}
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.skills.configOverridesDescription',
                    'Override default skill settings. These values take precedence over the packaged defaults.'
                  )}
                </p>
              </div>
              <div className="px-6 py-4 space-y-4">
                {/* Custom description */}
                <div>
                  <label
                    htmlFor="override-description"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.skills.field.customDescription', 'Custom Description')}
                  </label>
                  <textarea
                    id="override-description"
                    rows={3}
                    className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    placeholder={t(
                      'admin.skills.field.customDescriptionPlaceholder',
                      'Enter a custom description to override the default...'
                    )}
                    value={overrides.description}
                    onChange={e => setOverrides(prev => ({ ...prev, description: e.target.value }))}
                  />
                </div>
              </div>

              {/* Save / Cancel bar */}
              <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end space-x-3">
                <button
                  onClick={() => navigate('/admin/skills')}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleSaveOverrides}
                  disabled={saving}
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <Icon name="refresh" className="animate-spin h-4 w-4 mr-2" />
                      {t('common.saving', 'Saving...')}
                    </>
                  ) : (
                    <>
                      <Icon name="check" className="h-4 w-4 mr-2" />
                      {t('common.save', 'Save')}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminSkillEditPage;
