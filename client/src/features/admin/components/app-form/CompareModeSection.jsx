import { useTranslation } from 'react-i18next';

/**
 * CompareModeSection - Compare Mode toggle card for the App form.
 * Extracted from AppFormEditor.jsx (see #1781) as a self-contained slice:
 * only ever reads/writes `app.features.compareMode` via the passed-in onChange.
 */
function CompareModeSection({ app, onChange }) {
  const { t } = useTranslation();

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.compareMode', 'Compare Mode')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.compareModeDesc',
              'Allow users to query two models simultaneously and compare their responses side-by-side'
            )}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={app.features?.compareMode?.enabled !== false}
                onChange={e =>
                  onChange({
                    ...app,
                    features: {
                      ...app.features,
                      compareMode: { ...app.features?.compareMode, enabled: e.target.checked }
                    }
                  })
                }
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                {t('admin.apps.edit.enableCompareMode', 'Enable Compare Mode')}
              </label>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.apps.edit.compareModeNote',
                'When enabled, users can activate compare mode to send their input to two different models and view the responses side-by-side. The platform-level compare mode feature must also be enabled for this to work.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CompareModeSection;
