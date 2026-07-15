import Icon from './Icon';
import { getLocalizedContent } from '../../utils/localizeContent';
import AppNavigatorItem from './AppNavigatorItem';

function AppNavigatorCategory({
  group,
  fallbackLabel,
  isCollapsed,
  onToggle,
  currentLanguage,
  onNavigate
}) {
  const displayName = group.name ? getLocalizedContent(group.name, currentLanguage) : fallbackLabel;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded"
      >
        <span className="flex items-center gap-1.5 truncate">
          {group.color && (
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: group.color }}
              aria-hidden="true"
            />
          )}
          <span className="truncate">{displayName}</span>
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">
          {isCollapsed && (
            <span className="text-[10px] font-normal text-gray-400 dark:text-gray-500">
              {group.apps.length}
            </span>
          )}
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
        </span>
      </button>
      {!isCollapsed && (
        <div role="group" className="space-y-0.5 mt-0.5">
          {group.apps.map(app => (
            <AppNavigatorItem
              key={app.id}
              app={app}
              currentLanguage={currentLanguage}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default AppNavigatorCategory;
