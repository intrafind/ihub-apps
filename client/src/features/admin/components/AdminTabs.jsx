/**
 * Tab bar for admin pages that group related sub-pages.
 *
 * Controlled component — the parent owns the active tab and routing. Each tab
 * is rendered as a button; the parent decides what to mount in the content
 * area. Supports an optional count badge per tab.
 *
 * @param {Object} props
 * @param {Array<{ id: string, label: string, count?: number, icon?: React.ReactNode }>} props.tabs
 * @param {string} props.activeId
 * @param {(id: string) => void} props.onChange
 * @param {string} [props.ariaLabel='Tabs']
 */
function AdminTabs({ tabs = [], activeId, onChange, ariaLabel = 'Tabs' }) {
  return (
    <div className="border-b border-gray-200 dark:border-gray-700 mb-6">
      <nav className="-mb-px flex gap-6 overflow-x-auto" aria-label={ariaLabel} role="tablist">
        {tabs.map(tab => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              id={`tab-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange?.(tab.id)}
              className={[
                'inline-flex items-center gap-2 whitespace-nowrap border-b-2 py-3 px-1 text-sm font-medium transition-colors',
                isActive
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600'
              ].join(' ')}
            >
              {tab.icon && <span className="shrink-0">{tab.icon}</span>}
              {tab.label}
              {typeof tab.count === 'number' && (
                <span
                  className={[
                    'ml-1 inline-flex items-center justify-center rounded-full text-xs font-semibold px-2 py-0.5',
                    isActive
                      ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                  ].join(' ')}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export default AdminTabs;
