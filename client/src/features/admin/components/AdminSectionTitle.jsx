/**
 * Standardized section heading for admin form cards.
 * Replaces ad-hoc mix of text-lg/text-base/font-medium/font-semibold.
 *
 * @param {Object} props
 * @param {'h2'|'h3'} [props.as='h2'] Element to render
 * @param {string} [props.description] Optional muted description below title
 * @param {React.ReactNode} props.children
 */
function AdminSectionTitle({ as: Tag = 'h2', description, children }) {
  return (
    <div className="mb-4">
      <Tag className="text-base font-semibold text-gray-900 dark:text-gray-100">{children}</Tag>
      {description && (
        <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      )}
    </div>
  );
}

export default AdminSectionTitle;
