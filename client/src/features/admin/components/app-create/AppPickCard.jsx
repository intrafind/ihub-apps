// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import Icon from '../../../../shared/components/Icon';
import { DEFAULT_APP_COLOR, DEFAULT_APP_ICON } from '../../../../../../shared/appDefaults.js';

const CARD_CLASS =
  'flex w-full items-start gap-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-3 text-left shadow-xs hover:border-admin-accent dark:hover:border-admin-accent-fg-dark hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

const BADGE_CLASS =
  'mt-2 inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-200';

/**
 * An app as its tile shows it: the icon on the app's colour.
 *
 * @param {object} props
 * @param {string} [props.icon] - An icon name.
 * @param {string} [props.color] - `#RRGGBB`.
 * @param {'md'|'lg'} [props.size='md']
 * @returns {JSX.Element}
 */
export function AppTile({ icon, color, size = 'md' }) {
  const box = size === 'lg' ? 'h-14 w-14 rounded-xl' : 'h-10 w-10 rounded-lg';
  return (
    <span
      className={`flex shrink-0 items-center justify-center text-white ${box}`}
      style={{ backgroundColor: color || DEFAULT_APP_COLOR }}
      aria-hidden="true"
    >
      <Icon name={icon || DEFAULT_APP_ICON} size={size === 'lg' ? 'lg' : 'md'} />
    </span>
  );
}

/**
 * A template or an existing app as one button: the icon on its colour, the
 * name, one line, and a badge where there is something to say ("Input
 * fields"). It shows no ID.
 *
 * @param {object} props
 * @param {string} props.name
 * @param {string} [props.description] - One line under the name.
 * @param {string} [props.icon]
 * @param {string} [props.color]
 * @param {string} [props.badge]
 * @param {() => void} props.onPick
 * @returns {JSX.Element}
 */
function AppPickCard({ name, description, icon, color, badge, onPick }) {
  return (
    <button type="button" className={CARD_CLASS} onClick={onPick}>
      <AppTile icon={icon} color={color} />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-semibold text-gray-900 dark:text-gray-100">
          {name}
        </span>
        {description && (
          <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400 line-clamp-2">
            {description}
          </span>
        )}
        {badge && <span className={BADGE_CLASS}>{badge}</span>}
      </span>
    </button>
  );
}

export default AppPickCard;
