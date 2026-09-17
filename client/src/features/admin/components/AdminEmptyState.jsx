import Icon from '../../../shared/components/Icon';

/**
 * Consistent empty state for admin list pages.
 *
 * @param {Object} props
 * @param {string} [props.icon] Icon name from the Icon component
 * @param {string} props.title Primary message
 * @param {string} [props.description] Secondary message
 * @param {React.ReactNode} [props.action] CTA button or link
 */
function AdminEmptyState({ icon = 'inbox', title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
        <Icon name={icon} className="w-6 h-6 text-gray-400 dark:text-gray-500" />
      </div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export default AdminEmptyState;
