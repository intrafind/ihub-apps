// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';

/**
 * A tab chosen with the keyboard, focused once a tab bar shows it as active.
 * Kept outside the component: when each tab is its own (lazy) route, the tab
 * bar that renders the new tab is another instance, mounted after the route
 * has loaded. Expires so an abandoned move never steals focus later.
 * @type {{ id: string, until: number } | null}
 */
let pendingFocus = null;
const PENDING_FOCUS_MS = 5000;

/**
 * Tab bar for admin pages that group related sub-pages.
 *
 * Controlled component — the parent owns the active tab and routing. Each tab
 * is rendered as a button; the parent decides what to mount in the content
 * area. Supports an optional count badge per tab.
 *
 * Keyboard (WAI-ARIA tabs pattern): only the active tab is in the Tab order;
 * ArrowLeft / ArrowRight move to the previous / next tab and Home / End to the
 * first / last one, activating it and moving focus there. The parent renders a
 * `role="tabpanel"` with `id="tabpanel-<id>"` for each tab it wants announced.
 *
 * @param {Object} props
 * @param {Array<{ id: string, label: string, count?: number, icon?: React.ReactNode }>} props.tabs
 * @param {string} props.activeId
 * @param {(id: string) => void} props.onChange
 * @param {string} [props.ariaLabel='Tabs']
 */
function AdminTabs({ tabs = [], activeId, onChange, ariaLabel = 'Tabs' }) {
  useEffect(() => {
    if (!pendingFocus || pendingFocus.id !== activeId) return;
    const { until } = pendingFocus;
    pendingFocus = null;
    if (until > Date.now()) document.getElementById(`tab-${activeId}`)?.focus();
  }, [activeId]);

  const handleKeyDown = event => {
    // Leave browser shortcuts (Alt+Arrow = back, Cmd+Arrow, …) alone.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = tabs.findIndex(tab => tab.id === activeId);
    if (index === -1 || tabs.length < 2) return;
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const nextId = tabs[next].id;
    pendingFocus = { id: nextId, until: Date.now() + PENDING_FOCUS_MS };
    onChange?.(nextId);
  };

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 mb-6">
      <div className="-mb-px flex gap-6 overflow-x-auto" aria-label={ariaLabel} role="tablist">
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
              onKeyDown={handleKeyDown}
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
      </div>
    </div>
  );
}

export default AdminTabs;
