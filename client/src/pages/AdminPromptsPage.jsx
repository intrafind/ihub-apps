import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';
import Icon from '../components/Icon';
import AdminNavigation from '../components/AdminNavigation';

const AdminPromptsPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all, enabled, disabled
  const [selectedPrompt, setSelectedPrompt] = useState(null);

  useEffect(() => {
    loadPrompts();
  }, []);

  const loadPrompts = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/admin/prompts');
      if (!response.ok) {
        throw new Error('Failed to load prompts');
      }
      const data = await response.json();
      setPrompts(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const togglePrompt = async (promptId) => {
    try {
      const response = await fetch(`/api/admin/prompts/${promptId}/toggle`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error('Failed to toggle prompt');
      }
      
      const result = await response.json();
      
      // Update the prompt in the local state
      setPrompts(prev => prev.map(prompt => 
        prompt.id === promptId ? { ...prompt, enabled: result.enabled } : prompt
      ));
      
      // Show success message
      console.log(result.message);
    } catch (err) {
      console.error('Error toggling prompt:', err);
      alert(`Error: ${err.message}`);
    }
  };

  const deletePrompt = async (promptId) => {
    if (!confirm(t('admin.prompts.deleteConfirm', 'Are you sure you want to delete this prompt?'))) {
      return;
    }
    
    try {
      const response = await fetch(`/api/admin/prompts/${promptId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error('Failed to delete prompt');
      }
      
      // Remove the prompt from the local state
      setPrompts(prev => prev.filter(prompt => prompt.id !== promptId));
      
      alert(t('admin.prompts.deleteSuccess', 'Prompt deleted successfully'));
    } catch (err) {
      console.error('Error deleting prompt:', err);
      alert(`Error: ${err.message}`);
    }
  };

  const filteredPrompts = prompts.filter(prompt => {
    const matchesSearch = searchTerm === '' || 
      getLocalizedContent(prompt.name, currentLanguage).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getLocalizedContent(prompt.prompt, currentLanguage).toLowerCase().includes(searchTerm.toLowerCase()) ||
      (prompt.description && getLocalizedContent(prompt.description, currentLanguage).toLowerCase().includes(searchTerm.toLowerCase())) ||
      prompt.id.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesFilter = filterEnabled === 'all' || 
      (filterEnabled === 'enabled' && prompt.enabled !== false) ||
      (filterEnabled === 'disabled' && prompt.enabled === false);
    
    return matchesSearch && matchesFilter;
  });

  const sortedPrompts = [...filteredPrompts].sort((a, b) => {
    // Sort by order first, then by name
    if (a.order !== undefined && b.order !== undefined) {
      return a.order - b.order;
    }
    if (a.order !== undefined) return -1;
    if (b.order !== undefined) return 1;
    
    const aName = getLocalizedContent(a.name, currentLanguage);
    const bName = getLocalizedContent(b.name, currentLanguage);
    return aName.localeCompare(bName);
  });

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4">
        <div className="flex">
          <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800">
              {t('admin.prompts.loadError', 'Error loading prompts')}
            </h3>
            <p className="mt-1 text-sm text-red-700">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 text-sm text-red-600 hover:text-red-500"
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <AdminNavigation />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">
            {t('admin.prompts.title', 'Prompt Management')}
          </h1>
          <p className="mt-2 text-sm text-gray-700">
            {t('admin.prompts.subtitle', 'Create, edit, and manage prompts for your AI Hub Apps')}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            onClick={() => navigate('/admin/prompts/new')}
            className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
          >
            <Icon name="plus" className="h-4 w-4 mr-2" />
            {t('admin.prompts.createNew', 'Create New Prompt')}
          </button>
        </div>
      </div>

      {/* Search and Filter */}
      <div className="mt-8 flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Icon name="search" className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              placeholder={t('admin.prompts.searchPlaceholder', 'Search prompts...')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
        <div className="sm:w-48">
          <select
            value={filterEnabled}
            onChange={(e) => setFilterEnabled(e.target.value)}
            className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          >
            <option value="all">{t('admin.prompts.filterAll', 'All Prompts')}</option>
            <option value="enabled">{t('admin.prompts.filterEnabled', 'Enabled Only')}</option>
            <option value="disabled">{t('admin.prompts.filterDisabled', 'Disabled Only')}</option>
          </select>
        </div>
      </div>

      {/* Prompts Table */}
      <div className="mt-8 flex flex-col">
        <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {t('admin.prompts.name', 'Name')}
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {t('admin.prompts.description', 'Description')}
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {t('admin.prompts.order', 'Order')}
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {t('admin.prompts.appId', 'App ID')}
                    </th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {t('admin.prompts.status', 'Status')}
                    </th>
                    <th scope="col" className="relative px-6 py-3">
                      <span className="sr-only">{t('admin.prompts.actions', 'Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {sortedPrompts.map((prompt) => (
                    <tr key={prompt.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-8 w-8">
                            <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center">
                              <Icon name={prompt.icon || 'clipboard'} className="h-4 w-4 text-indigo-600" />
                            </div>
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">
                              {getLocalizedContent(prompt.name, currentLanguage)}
                            </div>
                            <div className="text-sm text-gray-500">
                              {prompt.id}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-900 max-w-xs truncate">
                          {prompt.description ? getLocalizedContent(prompt.description, currentLanguage) : '-'}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {prompt.order !== undefined ? prompt.order : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {prompt.appId ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                            {prompt.appId}
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          prompt.enabled !== false
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {prompt.enabled !== false ? t('admin.prompts.enabled', 'Enabled') : t('admin.prompts.disabled', 'Disabled')}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end space-x-2">
                          <button
                            onClick={() => navigate(`/admin/prompts/${prompt.id}`)}
                            className="text-indigo-600 hover:text-indigo-900"
                          >
                            <Icon name="pencil" className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => togglePrompt(prompt.id)}
                            className={`${
                              prompt.enabled !== false
                                ? 'text-yellow-600 hover:text-yellow-900'
                                : 'text-green-600 hover:text-green-900'
                            }`}
                          >
                            <Icon name={prompt.enabled !== false ? 'eye-slash' : 'eye'} className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => deletePrompt(prompt.id)}
                            className="text-red-600 hover:text-red-900"
                          >
                            <Icon name="trash" className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {sortedPrompts.length === 0 && (
        <div className="text-center py-12">
          <Icon name="clipboard" className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            {t('admin.prompts.noPrompts', 'No prompts found')}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {t('admin.prompts.noPromptsDesc', 'Get started by creating a new prompt.')}
          </p>
          <div className="mt-6">
            <button
              onClick={() => navigate('/admin/prompts/new')}
              className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <Icon name="plus" className="h-4 w-4 mr-2" />
              {t('admin.prompts.createNew', 'Create New Prompt')}
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};

export default AdminPromptsPage;