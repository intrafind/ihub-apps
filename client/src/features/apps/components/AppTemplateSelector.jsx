import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import { fetchAdminAppTemplates } from '../../../api/adminApi';

const AppTemplateSelector = ({ onSelect, onClose }) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadApps();
  }, []);

  const loadApps = async () => {
    try {
      setLoading(true);
      const templates = await fetchAdminAppTemplates();
      setApps(templates);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const filteredApps = apps.filter(app => {
    const matchesSearch =
      getLocalizedContent(app.name, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      getLocalizedContent(app.description, currentLanguage)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      app.id.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesSearch;
  });

  const handleSelectApp = app => {
    onSelect(app);
    onClose();
  };

  const createFromScratch = () => {
    onSelect(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-20 mx-auto p-5 border w-11/12 max-w-3xl shadow-lg rounded-md bg-white">
        <div className="mt-3">
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                {t('admin.apps.template.title', 'Choose App Template')}
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                {t(
                  'admin.apps.template.description',
                  'Start with an existing app as a template, or create from scratch'
                )}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <Icon name="x" className="h-6 w-6" />
            </button>
          </div>

          {/* Search */}
          <div className="py-4">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Icon name="search" className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                placeholder={t('admin.apps.template.searchPlaceholder', 'Search apps...')}
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="block w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Create from scratch option */}
          <div className="mb-4">
            <button
              onClick={createFromScratch}
              className="w-full flex items-center p-4 border-2 border-dashed border-gray-300 rounded-lg hover:border-indigo-500 hover:bg-indigo-50 transition-colors"
            >
              <div className="flex items-center justify-center w-10 h-10 bg-gray-100 rounded-lg mr-4">
                <Icon name="plus" className="h-6 w-6 text-gray-600" />
              </div>
              <div className="text-left">
                <div className="text-sm font-medium text-gray-900">
                  {t('admin.apps.template.createFromScratch', 'Create from Scratch')}
                </div>
                <div className="text-sm text-gray-500">
                  {t(
                    'admin.apps.template.createFromScratchDescription',
                    'Start with a blank app configuration'
                  )}
                </div>
              </div>
            </button>
          </div>

          {/* Template apps */}
          {loading && (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mx-auto"></div>
              <p className="mt-2 text-sm text-gray-600">
                {t('admin.apps.template.loading', 'Loading apps...')}
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4">
              <div className="flex">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                <div className="ml-3">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              </div>
            </div>
          )}

          {!loading && !error && (
            <div className="max-h-96 overflow-y-auto">
              <div className="space-y-2">
                {filteredApps.map(app => (
                  <button
                    key={app.id}
                    onClick={() => handleSelectApp(app)}
                    className="w-full flex items-center p-4 border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 text-left transition-colors"
                  >
                    <div
                      className="flex items-center justify-center w-10 h-10 rounded-lg text-white font-bold mr-4"
                      style={{ backgroundColor: app.color || '#6B7280' }}
                    >
                      {getLocalizedContent(app.name, currentLanguage).charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-900">
                        {getLocalizedContent(app.name, currentLanguage)}
                      </div>
                      <div className="text-sm text-gray-500">
                        {getLocalizedContent(app.description, currentLanguage)}
                      </div>
                      <div className="flex items-center mt-1">
                        <span className="text-xs text-gray-400">ID: {app.id}</span>
                        {app.variables?.length > 0 && (
                          <span className="ml-3 text-xs text-gray-400">
                            {app.variables.length} variables
                          </span>
                        )}
                        {app.tools?.length > 0 && (
                          <span className="ml-3 text-xs text-gray-400">
                            {app.tools.length} tools
                          </span>
                        )}
                      </div>
                    </div>
                    <Icon name="chevron-down" className="h-5 w-5 text-gray-400" />
                  </button>
                ))}
              </div>

              {filteredApps.length === 0 && !loading && (
                <div className="text-center py-8 text-gray-500">
                  <Icon name="search" className="h-8 w-8 mx-auto mb-2" />
                  <p>{t('admin.apps.template.noApps', 'No apps found matching your search')}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AppTemplateSelector;
