import Icon from '../../../../shared/components/Icon';
import SourcePicker from '../SourcePicker';

/**
 * SourcesConfigSection - Data source selection card for chat apps, extracted
 * from AppFormEditor. Only rendered when the sources feature flag is enabled
 * (checked by the caller).
 *
 * @component
 */
function SourcesConfigSection({ app, onChange, t }) {
  const handleSourcesChange = selectedSourceIds => {
    onChange({
      ...app,
      sources: selectedSourceIds
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.sources', 'Sources Configuration')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.sourcesDesc',
              'Configure data sources that provide content to this app'
            )}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-6">
            {/* Source References */}
            <div>
              <p className="text-sm text-gray-600 mb-4">
                {t(
                  'admin.apps.edit.sourcesDesc',
                  'Select data sources configured in the admin interface to provide content to this app'
                )}
              </p>
              <SourcePicker
                value={app.sources || []}
                onChange={handleSourcesChange}
                allowMultiple={true}
                className="mb-4"
              />
            </div>

            {/* Sources Summary */}
            {app.sources && app.sources.length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <Icon name="information-circle" className="h-5 w-5 text-blue-400" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-blue-800">
                      {t('admin.apps.edit.sourcesConfigured', 'Sources Configured')}
                    </h3>
                    <div className="mt-2 text-sm text-blue-700">
                      <p>
                        {t(
                          'admin.apps.edit.sourcesCount',
                          'This app has {{count}} source(s) configured:',
                          {
                            count: app.sources.length
                          }
                        )}
                      </p>
                      <ul className="list-disc list-inside mt-1 space-y-1">
                        {app.sources.map((sourceId, index) => (
                          <li key={`source-${index}`}>
                            <span className="font-mono text-xs bg-blue-100 px-1 rounded">
                              {sourceId}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs">
                        {t(
                          'admin.apps.edit.sourcesUsage',
                          'Sources will be loaded and their content made available via {{sources}} template in system prompts.'
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SourcesConfigSection;
