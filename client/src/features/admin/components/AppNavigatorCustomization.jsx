import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';

function AppNavigatorCustomization({ config, categories, onUpdate, t }) {
  const categoryOrder = config.categoryOrder || [];
  const availableCategoryIds = (categories || [])
    .filter(category => category.id !== 'all')
    .map(category => category.id);

  // Explicitly ordered ids first, then any remaining known categories not yet ordered.
  const orderedIds = [
    ...categoryOrder.filter(id => availableCategoryIds.includes(id)),
    ...availableCategoryIds.filter(id => !categoryOrder.includes(id))
  ];

  const categoryLabel = id => {
    const category = (categories || []).find(c => c.id === id);
    return category ? getLocalizedContent(category.name, 'en') || id : id;
  };

  const moveUp = index => {
    if (index === 0) return;
    const next = [...orderedIds];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onUpdate({ categoryOrder: next });
  };

  const moveDown = index => {
    if (index === orderedIds.length - 1) return;
    const next = [...orderedIds];
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    onUpdate({ categoryOrder: next });
  };

  return (
    <div className="p-6">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-6">
        {t('admin.ui.appNavigator.title', 'App Navigator Sidebar')}
      </h3>

      <div className="space-y-6">
        <div>
          <div className="flex items-center">
            <input
              type="checkbox"
              checked={config.enabled !== false}
              onChange={e => onUpdate({ enabled: e.target.checked })}
              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
            />
            <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
              {t('admin.ui.appNavigator.enabled', 'Enable App Navigator Sidebar')}
            </label>
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.ui.appNavigator.enabledHint',
              'Shows a hamburger button that opens a searchable, categorized sidebar for quickly switching between apps without leaving the current chat.'
            )}
          </p>
        </div>

        {config.enabled !== false && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.ui.appNavigator.categoryOrder', 'Category Display Order')}
            </label>
            <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.ui.appNavigator.categoryOrderHint',
                'Controls the order categories appear in the sidebar. Categories themselves are defined under Apps List > Categories.'
              )}
            </p>

            {orderedIds.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t(
                  'admin.ui.appNavigator.noCategories',
                  'No app categories configured yet. Add categories under Apps List > Categories first.'
                )}
              </p>
            ) : (
              <ul className="space-y-2">
                {orderedIds.map((id, index) => (
                  <li
                    key={id}
                    className="flex items-center justify-between border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2"
                  >
                    <span className="text-sm text-gray-900 dark:text-gray-100">
                      {categoryLabel(id)}
                    </span>
                    <div className="flex items-center space-x-1">
                      <button
                        type="button"
                        onClick={() => moveUp(index)}
                        disabled={index === 0}
                        className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label={t('admin.ui.appNavigator.moveUp', 'Move up')}
                      >
                        <Icon name="chevron-up" size="sm" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveDown(index)}
                        disabled={index === orderedIds.length - 1}
                        className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label={t('admin.ui.appNavigator.moveDown', 'Move down')}
                      >
                        <Icon name="chevron-down" size="sm" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default AppNavigatorCustomization;
