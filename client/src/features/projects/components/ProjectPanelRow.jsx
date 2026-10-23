// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import Icon from '../../../shared/components/Icon';

/** The card that holds the rows of a project page's side panel. */
export const PANEL_CARD =
  'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl divide-y divide-gray-100 dark:divide-gray-700/70';

/** A row's action (Edit, Share, …): a quiet text button on the right. */
export const ROW_ACTION =
  'text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed flex-none';

/**
 * One row of the project page's side panel: an icon, a title, an action on
 * the right, and an optional summary below the title.
 *
 * @param {Object} props
 * @param {string} props.icon
 * @param {string} props.title
 * @param {string} props.titleId - Id of the heading, which names the row.
 * @param {import('react').ReactNode} [props.action]
 * @param {import('react').ReactNode} [props.children]
 * @param {string} [props.testId]
 * @returns {JSX.Element}
 */
function ProjectPanelRow({ icon, title, titleId, action = null, children = null, testId }) {
  return (
    <section className="px-4 py-3.5" aria-labelledby={titleId} data-testid={testId}>
      <div className="flex items-center gap-3">
        <Icon name={icon} size="sm" className="flex-none text-gray-500 dark:text-gray-400" />
        <h2
          id={titleId}
          className="flex-1 min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100"
        >
          {title}
        </h2>
        {action}
      </div>
      {children && <div className="mt-1.5 pl-7 text-sm min-w-0">{children}</div>}
    </section>
  );
}

export default ProjectPanelRow;
