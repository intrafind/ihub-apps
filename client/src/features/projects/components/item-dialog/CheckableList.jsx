// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A scrolling list of rows with a checkbox each, as the "Add item" dialog
 * shows documents to link and pages of a website to add. A row the project
 * has already is shown ticked, disabled and muted.
 *
 * @param {Object} props
 * @param {Array<{key: string, checked: boolean, disabled?: boolean, muted?: boolean,
 *   onToggle: () => void, content: JSX.Element, badge?: JSX.Element,
 *   action?: JSX.Element}>} props.rows - `content` sits in the checkbox's label;
 *   `action` (a button) beside it.
 * @param {string} [props.emptyText] - Shown when there are no rows.
 * @param {string} [props.testId]
 * @returns {JSX.Element}
 */
function CheckableList({ rows, emptyText, testId }) {
  return (
    <ul
      className="max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700"
      data-testid={testId}
    >
      {rows.length === 0 && emptyText && (
        <li className="p-3 text-sm text-gray-500 dark:text-gray-400">{emptyText}</li>
      )}
      {rows.map(row => (
        <li key={row.key} className="flex items-center">
          <label
            className={`flex items-center gap-3 flex-1 min-w-0 px-3 py-2 text-sm ${
              row.muted ? 'opacity-60' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
            }`}
          >
            <input
              type="checkbox"
              checked={row.checked}
              onChange={row.onToggle}
              disabled={row.disabled}
              className="h-4 w-4 text-indigo-600 border-gray-300 rounded-sm focus:ring-indigo-500"
            />
            <span className="flex-1 min-w-0">{row.content}</span>
            {row.badge}
          </label>
          {row.action && <span className="pr-2">{row.action}</span>}
        </li>
      ))}
    </ul>
  );
}

export default CheckableList;
