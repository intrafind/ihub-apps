// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import InputVariables from './InputVariables';

const iconButtonClass =
  'p-1 rounded-sm text-gray-500 hover:text-gray-700 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500';

/**
 * The input parameters beside the chat (desktop), which the user can
 * collapse, expand and pin (issue #3053; state from `useVariablesPanel`).
 *
 * Beside the chat it collapses to a narrow strip; stacked above it (embedded)
 * to its header.
 */
function VariablesPanel({
  variables,
  setVariables,
  localizedVariables,
  stacked = false,
  collapsed,
  pinned,
  onToggleCollapsed,
  onTogglePinned
}) {
  const { t } = useTranslation();
  const title = t('pages.appChat.inputParameters');
  const expandLabel = t('pages.appChat.variablesPanel.expand', 'Show input parameters');
  const collapseLabel = t('pages.appChat.variablesPanel.collapse', 'Hide input parameters');
  const pinLabel = pinned
    ? t('pages.appChat.variablesPanel.unpin', 'Unpin: hide the input parameters after each message')
    : t('pages.appChat.variablesPanel.pin', 'Pin: keep the input parameters open');

  if (collapsed && !stacked) {
    return (
      <div className="hidden md:flex flex-col items-center py-3 w-10 bg-gray-50 dark:bg-gray-800 rounded-lg shrink-0">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={`${iconButtonClass} flex flex-col items-center gap-3`}
          aria-label={expandLabel}
          aria-expanded="false"
          title={expandLabel}
        >
          <Icon name="chevron-double-left" size="sm" />
          <Icon name="document-chart-bar" size="sm" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`hidden md:block overflow-y-auto p-4 bg-gray-50 dark:bg-gray-800 rounded-lg shrink-0 ${stacked ? 'order-first max-h-60' : 'w-80 lg:w-96'}`}
    >
      <div className={`flex items-center justify-between gap-2 ${collapsed ? '' : 'mb-3'}`}>
        <h3 className="font-medium text-gray-900 dark:text-gray-100">{title}</h3>
        <div className="flex items-center gap-1">
          {!collapsed && (
            <button
              type="button"
              onClick={onTogglePinned}
              className={`${iconButtonClass} ${pinned ? 'text-indigo-600 dark:text-indigo-400' : ''}`}
              aria-pressed={pinned}
              aria-label={pinLabel}
              title={pinLabel}
            >
              <Icon name="pin" size="sm" solid={pinned} />
            </button>
          )}
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={iconButtonClass}
            aria-label={collapsed ? expandLabel : collapseLabel}
            aria-expanded={!collapsed}
            title={collapsed ? expandLabel : collapseLabel}
          >
            <Icon
              name={stacked ? (collapsed ? 'chevron-down' : 'chevron-up') : 'chevron-double-right'}
              size="sm"
            />
          </button>
        </div>
      </div>
      {!collapsed && (
        <InputVariables
          variables={variables}
          setVariables={setVariables}
          localizedVariables={localizedVariables}
        />
      )}
    </div>
  );
}

export default VariablesPanel;
