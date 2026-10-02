import { useRef } from 'react';

/**
 * Tab bar for admin pages that group related sub-pages.
 *
 * Controlled component — the parent owns the active tab and routing. Each tab
 * is rendered as a button; the parent decides what to mount in the content
 * area. Supports an optional count badge per tab.
 *
 * Keyboard support follows the WAI-ARIA tabs pattern: only the active tab is
 * in the Tab order (roving `tabIndex`), Arrow Left/Right move between tabs,
 * Home/End jump to the first/last tab. With `activation="manual"` (default)
 * arrow keys only move focus and Enter/Space activates the focused tab; with
 * `activation="automatic"` moving focus also activates the tab.
 *
 * The parent renders the panel with `id={`${idPrefix}tabpanel-${id}`}`,
 * `role="tabpanel"` and `aria-labelledby={`${idPrefix}tab-${id}`}`.
 *
 * @param {Object} props
 * @param {Array<{ id: string, label: string, count?: number, icon?: React.ReactNode }>} props.tabs
 * @param {string} props.activeId
 * @param {(id: string) => void} props.onChange
 * @param {string} [props.ariaLabel='Tabs']
 * @param {string} [props.idPrefix=''] Prefix for the tab/panel element ids, so
 *   two tab bars on one page (or generic ids like `overview`) never collide.
 * @param {'manual'|'automatic'} [props.activation='manual'] Whether arrow keys
 *   also activate the tab they move to.
 */
function AdminTabs({
  tabs = [],
  activeId,
  onChange,
  ariaLabel = 'Tabs',
  idPrefix = '',
  activation = 'manual'
}) {
  const tabButtonsRef = useRef({});

  /**
   * Move focus (and, for automatic activation, the selection) to a tab.
   * @param {number} index - Index into `tabs`, wrapped around both ends.
   */
  const focusTabAt = index => {
    if (tabs.length === 0) return;
    const wrapped = (index + tabs.length) % tabs.length;
    const target = tabs[wrapped];
    tabButtonsRef.current[target.id]?.focus();
    if (activation === 'automatic') onChange?.(target.id);
  };

  const handleKeyDown = (event, index) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTabAt(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTabAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTabAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusTabAt(tabs.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 mb-6">
      <div className="-mb-px flex gap-6 overflow-x-auto" aria-label={ariaLabel} role="tablist">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              ref={el => {
                tabButtonsRef.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`${idPrefix}tabpanel-${tab.id}`}
              id={`${idPrefix}tab-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange?.(tab.id)}
              onKeyDown={event => handleKeyDown(event, index)}
              className={[
                'inline-flex items-center gap-2 whitespace-nowrap border-b-2 py-3 px-1 text-sm font-medium transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900',
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
      </div>
    </div>
  );
}

export default AdminTabs;
