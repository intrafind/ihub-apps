import { NavLink } from 'react-router-dom';
import Icon from './Icon';
import { getLocalizedContent } from '../../utils/localizeContent';

function AppNavigatorItem({ app, currentLanguage, onNavigate }) {
  return (
    <NavLink
      to={`/apps/${app.id}`}
      onClick={onNavigate}
      role="menuitem"
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-2 rounded-md text-sm truncate transition-colors ${
          isActive
            ? 'bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
        }`
      }
    >
      <Icon name={app.icon || 'lightning-bolt'} size="sm" className="flex-shrink-0" />
      <span className="truncate">{getLocalizedContent(app.name, currentLanguage) || app.id}</span>
    </NavLink>
  );
}

export default AppNavigatorItem;
