import { useTranslation } from 'react-i18next';
import AppsSelector from '../../../../shared/components/AppsSelector';

function AppsConfigSection({ appId, selectedApps, onAppsChange }) {
  const { t } = useTranslation();

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.appsAsTools', 'Apps as Tools')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.appsAsToolsDesc',
              'Let this app delegate to other apps. The model can call each selected app as a tool and use its answer (concierge pattern).'
            )}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2">
          <AppsSelector
            selectedApps={selectedApps}
            onAppsChange={onAppsChange}
            excludeAppId={appId}
          />
        </div>
      </div>
    </div>
  );
}

export default AppsConfigSection;
