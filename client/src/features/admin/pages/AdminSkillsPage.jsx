import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import {
  fetchAdminSkills,
  toggleSkill,
  deleteSkill,
  exportSkill,
  importSkill
} from '../../../api/adminApi';

/**
 * AdminSkillsPage - List page for managing installed skills.
 *
 * Displays all skills in a searchable, filterable table with actions for
 * toggling enabled/disabled state, exporting, deleting, and importing new
 * skills from .zip archives.
 *
 * Follows the same layout conventions as AdminToolsPage.
 */
const AdminSkillsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all | enabled | disabled
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadSkills();
  }, []);

  /**
   * Fetches the full list of skills from the admin API and stores
   * them in local state.
   */
  const loadSkills = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAdminSkills();
      const skillsArray = Array.isArray(data) ? data : [];
      setSkills(skillsArray);

      if (skillsArray.length === 0) {
        console.warn('No skills returned from API');
      }
    } catch (err) {
      console.error('Error loading skills:', err);
      setError(err.message);
      setSkills([]);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Toggles a skill between enabled and disabled states, then reloads.
   * @param {string} skillName - The unique name identifier of the skill
   */
  const handleToggleSkill = async skillName => {
    try {
      await toggleSkill(skillName);
      await loadSkills();
    } catch (err) {
      setError(err.message);
    }
  };

  /**
   * Deletes a skill after user confirmation, then reloads the list.
   * @param {string} skillName - The unique name identifier of the skill
   */
  const handleDeleteSkill = async skillName => {
    if (!confirm(t('admin.skills.deleteConfirm', 'Are you sure you want to delete this skill?'))) {
      return;
    }

    try {
      await deleteSkill(skillName);
      await loadSkills();
      alert(t('admin.skills.deleteSuccess', 'Skill deleted successfully'));
    } catch (err) {
      console.error('Error deleting skill:', err);
      alert(err.message || 'Failed to delete skill');
    }
  };

  /**
   * Triggers a download of the skill package as a .zip file.
   * @param {string} skillName - The unique name identifier of the skill
   */
  const handleExportSkill = async skillName => {
    try {
      await exportSkill(skillName);
    } catch (err) {
      setError(`Failed to export skill: ${err.message}`);
    }
  };

  /**
   * Handles uploading a .zip skill package via a hidden file input.
   * @param {Event} event - The change event from the file input
   */
  const handleImportSkill = async event => {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.zip')) {
      setError(t('admin.skills.invalidFileType', 'Please select a .zip file'));
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('skill', file);
      await importSkill(formData);
      await loadSkills();
      event.target.value = '';
    } catch (err) {
      if (err.message.includes('already exists')) {
        setError(t('admin.skills.importAlreadyExists', 'A skill with this name already exists'));
      } else {
        setError(`${t('admin.skills.importFailed', 'Failed to import skill')}: ${err.message}`);
      }
    } finally {
      setUploading(false);
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Filtering & sorting                                                */
  /* ------------------------------------------------------------------ */

  const filteredSkills = skills.filter(skill => {
    const name = skill.displayName || skill.name || '';
    const description = skill.description || '';

    const matchesSearch =
      searchTerm === '' ||
      name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (skill.name || '').toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter =
      filterEnabled === 'all' ||
      (filterEnabled === 'enabled' && skill.enabled !== false) ||
      (filterEnabled === 'disabled' && skill.enabled === false);

    return matchesSearch && matchesFilter;
  });

  const sortedSkills = [...filteredSkills].sort((a, b) => {
    const aName = a.displayName || a.name || '';
    const bName = b.displayName || b.name || '';
    return aName.localeCompare(bName);
  });

  /* ------------------------------------------------------------------ */
  /*  Render: loading state                                              */
  /* ------------------------------------------------------------------ */

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Render: error-only state (before skills loaded)                    */
  /* ------------------------------------------------------------------ */

  if (error && skills.length === 0) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
        <div className="flex">
          <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
              {t('admin.skills.loadError', 'Error loading skills')}
            </h3>
            <p className="mt-1 text-sm text-red-700 dark:text-red-400">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 text-sm text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Render: main page                                                  */
  /* ------------------------------------------------------------------ */

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Page header */}
          <div className="sm:flex sm:items-center">
            <div className="sm:flex-auto">
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.skills.title', 'Skill Management')}
              </h1>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                {t(
                  'admin.skills.subtitle',
                  'Install, configure, and manage skills for your iHub Apps'
                )}
              </p>
            </div>
            <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
              <div className="flex flex-wrap gap-2">
                {/* Import / Upload skill button */}
                <div className="relative">
                  <input
                    type="file"
                    accept=".zip"
                    onChange={handleImportSkill}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={uploading}
                  />
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={uploading}
                    title={t('admin.skills.importSkill', 'Import Skill (.zip)')}
                  >
                    <Icon
                      name={uploading ? 'refresh' : 'upload'}
                      className={`h-4 w-4 mr-2 ${uploading ? 'animate-spin' : ''}`}
                    />
                    {uploading
                      ? t('admin.skills.uploading', 'Uploading...')
                      : t('admin.skills.importSkill', 'Import Skill')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Inline error banner (shown alongside data) */}
          {error && skills.length > 0 && (
            <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
              <div className="flex">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                <div className="ml-3 flex-1">
                  <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
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

          {/* Search and filter controls */}
          <div className="mt-8 flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Icon name="search" className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md leading-5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  placeholder={t('admin.skills.searchPlaceholder', 'Search skills...')}
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
            <div className="sm:w-48">
              <select
                value={filterEnabled}
                onChange={e => setFilterEnabled(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              >
                <option value="all">{t('admin.skills.filterAll', 'All Skills')}</option>
                <option value="enabled">{t('admin.skills.filterEnabled', 'Enabled Only')}</option>
                <option value="disabled">
                  {t('admin.skills.filterDisabled', 'Disabled Only')}
                </option>
              </select>
            </div>
          </div>

          {/* Skills table */}
          <div className="mt-8 flex flex-col">
            <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
              <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
                <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                  <table className="min-w-full divide-y divide-gray-300 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.skills.table.name', 'Name')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.skills.table.description', 'Description')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.skills.table.version', 'Version')}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('admin.skills.table.status', 'Status')}
                        </th>
                        <th scope="col" className="relative px-6 py-3">
                          <span className="sr-only">
                            {t('admin.skills.table.actions', 'Actions')}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                      {sortedSkills.map(skill => (
                        <tr
                          key={skill.name}
                          className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                          onClick={() => navigate(`/admin/skills/${skill.name}`)}
                        >
                          {/* Name cell */}
                          <td className="px-6 py-4">
                            <div className="flex items-center">
                              <div className="flex-shrink-0 h-8 w-8">
                                <div className="h-8 w-8 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center">
                                  <Icon
                                    name="sparkles"
                                    className="h-4 w-4 text-indigo-600 dark:text-indigo-400"
                                  />
                                </div>
                              </div>
                              <div className="ml-4">
                                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                  {skill.displayName || skill.name}
                                </div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">
                                  {skill.name}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Description cell */}
                          <td className="px-6 py-4">
                            <div className="text-sm text-gray-900 dark:text-gray-100 max-w-xs truncate">
                              {skill.description || '-'}
                            </div>
                          </td>

                          {/* Version cell */}
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                            {skill.metadata?.version ? (
                              <code className="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
                                {skill.metadata.version}
                              </code>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>

                          {/* Status cell */}
                          <td className="px-6 py-4">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                skill.enabled !== false
                                  ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                              }`}
                            >
                              {skill.enabled !== false
                                ? t('admin.skills.enabled', 'Enabled')
                                : t('admin.skills.disabled', 'Disabled')}
                            </span>
                          </td>

                          {/* Actions cell */}
                          <td className="px-6 py-4 text-right text-sm font-medium">
                            <div className="flex items-center justify-end space-x-2">
                              {/* Toggle enabled/disabled */}
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleToggleSkill(skill.name);
                                }}
                                className={`p-2 rounded-full ${
                                  skill.enabled !== false
                                    ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30'
                                    : 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30'
                                }`}
                                title={
                                  skill.enabled !== false
                                    ? t('admin.skills.disable', 'Disable')
                                    : t('admin.skills.enable', 'Enable')
                                }
                              >
                                <Icon
                                  name={skill.enabled !== false ? 'eye-slash' : 'eye'}
                                  className="h-4 w-4"
                                />
                              </button>

                              {/* Export */}
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleExportSkill(skill.name);
                                }}
                                className="p-2 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30 rounded-full"
                                title={t('admin.skills.export', 'Export Skill')}
                              >
                                <Icon name="download" className="h-4 w-4" />
                              </button>

                              {/* Edit / view detail */}
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  navigate(`/admin/skills/${skill.name}`);
                                }}
                                className="p-2 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-full"
                                title={t('admin.skills.edit', 'Edit')}
                              >
                                <Icon name="pencil" className="h-4 w-4" />
                              </button>

                              {/* Delete */}
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  handleDeleteSkill(skill.name);
                                }}
                                className="p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-full"
                                title={t('admin.skills.delete', 'Delete')}
                              >
                                <Icon name="trash" className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Empty state */}
                  {sortedSkills.length === 0 && (
                    <div className="text-center py-12 bg-gray-50 dark:bg-gray-800">
                      <Icon
                        name="sparkles"
                        className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
                      />
                      <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {t('admin.skills.noSkills', 'No skills found')}
                      </h3>
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        {t(
                          'admin.skills.noSkillsDescription',
                          'Get started by importing a skill package.'
                        )}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminSkillsPage;
