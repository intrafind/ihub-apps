import { Link } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';

/**
 * Breadcrumb trail for admin edit/detail pages.
 *
 * @param {Object} props
 * @param {Array<{ label: string, href?: string }>} props.crumbs
 *   Each crumb with a `href` renders as a link; the last crumb is always plain text.
 */
function AdminBreadcrumb({ crumbs = [] }) {
  if (crumbs.length === 0) return null;

  return (
    <nav className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 mb-4" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={index} className="flex items-center gap-1 min-w-0">
            {index > 0 && (
              <Icon name="chevron-right" className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-gray-600" />
            )}
            {isLast || !crumb.href ? (
              <span
                className={
                  isLast
                    ? 'font-medium text-gray-900 dark:text-gray-100 truncate max-w-[200px]'
                    : 'truncate max-w-[120px]'
                }
                aria-current={isLast ? 'page' : undefined}
              >
                {crumb.label}
              </span>
            ) : (
              <Link
                to={crumb.href}
                className="truncate max-w-[120px] hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export default AdminBreadcrumb;
