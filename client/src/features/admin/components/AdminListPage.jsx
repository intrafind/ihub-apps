import AdminBreadcrumb from './AdminBreadcrumb';

/**
 * Standard layout for admin list pages.
 *
 * Composes the recurring structure: container, breadcrumb, header (title +
 * description + actions), optional toolbar (filters/search), and content slot.
 * Adopt incrementally — pages can still render their own JSX inside `children`.
 *
 * @param {Object} props
 * @param {Array<{ label: string, href?: string }>} [props.crumbs]
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {React.ReactNode} [props.actions] Primary CTA(s) rendered on the right of the header
 * @param {React.ReactNode} [props.toolbar] Filter bar / search row rendered below the header
 * @param {'4xl'|'5xl'|'6xl'|'7xl'} [props.maxWidth='6xl']
 * @param {React.ReactNode} props.children Content area (table, grid, empty state)
 */
function AdminListPage({
  crumbs,
  title,
  description,
  actions,
  toolbar,
  maxWidth = '6xl',
  children
}) {
  const widthClass =
    {
      '4xl': 'max-w-4xl',
      '5xl': 'max-w-5xl',
      '6xl': 'max-w-6xl',
      '7xl': 'max-w-7xl'
    }[maxWidth] ?? 'max-w-6xl';

  return (
    <div className={`${widthClass} mx-auto px-4 sm:px-6 lg:px-8 py-8`}>
      {crumbs && crumbs.length > 0 && <AdminBreadcrumb crumbs={crumbs} />}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2 sm:shrink-0">{actions}</div>}
      </div>
      {toolbar && <div className="mb-4">{toolbar}</div>}
      <div className="space-y-6">{children}</div>
    </div>
  );
}

export default AdminListPage;
