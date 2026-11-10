// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Shared Tailwind class strings for buttons, so the workspace pane, the Files
 * index and the source view stop carrying their own copies of
 * `ICON_BUTTON` / `SECONDARY` / `PRIMARY`.
 *
 * Every control is at least 32px high (WCAG 2.5.8 asks for 24px) and shows an
 * indigo focus ring on keyboard focus.
 *
 * @module shared/utils/buttonTokens
 */

const FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-gray-900';

/** A square 32px icon-only button. Give it an `aria-label`. */
export const ICON_BUTTON = `inline-flex h-8 w-8 flex-none items-center justify-center rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`;

/** A 32px button with an icon and a label, no border. */
export const GHOST_BUTTON = `inline-flex h-8 flex-none items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`;

/** A bordered secondary button. */
export const SECONDARY_BUTTON = `inline-flex h-8 flex-none items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 px-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`;

/** The one primary action of a surface. */
export const PRIMARY_BUTTON = `inline-flex h-8 flex-none items-center gap-1.5 rounded-md bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`;

/** A destructive action. */
export const DANGER_BUTTON = `inline-flex h-8 flex-none items-center gap-1.5 rounded-md border border-red-300 dark:border-red-700 px-3 text-sm font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS}`;

/** An item of a popup menu (`role="menuitem"`). */
export const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none disabled:opacity-50';

/** The container of a segmented control (Preview | Code). */
export const SEGMENTED =
  'inline-flex h-8 flex-none items-center rounded-md bg-gray-100 dark:bg-gray-700/60 p-0.5';

/** One segment; `active` marks the selected one. */
export const segmentClass = active =>
  `inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium ${FOCUS} ${
    active
      ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-xs'
      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
  }`;
