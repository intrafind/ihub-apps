// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import Icon from '../../../../shared/components/Icon';
import { DEFAULT_APP_COLOR, DEFAULT_APP_ICON } from '../../../../../../shared/appDefaults.js';

// `h-full`: in a grid with equal rows (`auto-rows-fr`) every card has the same size.
const CARD_CLASS =
  'flex h-full w-full items-start gap-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-3 text-left shadow-xs hover:border-admin-accent dark:hover:border-admin-accent-fg-dark hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

// `mt-auto` keeps the badge at the foot of the card, where it lines up with its neighbours.
const BADGE_CLASS =
  'mt-auto inline-flex self-start rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-200';

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
 * name, two lines of description, and a badge where there is something to say
 * ("Input fields"). It shows no ID.
 *
 * The cards of a grid share one size: the name and the description are cut to
 * two lines each. The cut is visual only: a screen reader reads the whole
 * text, and the `title` shows it on hover.
 * `line-clamp-2` sets its own `display`: a `block` beside it would undo the cut.
 *
 * @param {object} props
 * @param {string} props.name
 * @param {string} [props.description] - Up to two lines under the name.
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
      <span className="flex min-w-0 flex-1 flex-col gap-2 self-stretch">
        <span className="min-w-0">
          <span
            className="break-words text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-2"
            title={name}
          >
            {name}
          </span>
          {description && (
            <span
              className="mt-0.5 text-xs text-gray-600 dark:text-gray-400 line-clamp-2"
              title={description}
            >
              {description}
            </span>
          )}
        </span>
        {badge && <span className={BADGE_CLASS}>{badge}</span>}
      </span>
    </button>
  );
}

export default AppPickCard;
