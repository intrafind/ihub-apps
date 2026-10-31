// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Class names shared by the people directory admin pages. The project does not
 * use @tailwindcss/forms, so inputs set border, padding, colours and a visible
 * focus ring explicitly (as the A2A agents and MCP servers pages do).
 */

export const INPUT_CLASS =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs px-3 py-2 text-sm focus:outline-hidden focus:border-blue-500 focus:ring-2 focus:ring-blue-500 disabled:opacity-60';

export const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;

export const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

export const HELP_CLASS = 'mt-1 text-xs text-gray-600 dark:text-gray-400';

export const CHECKBOX_CLASS =
  'h-4 w-4 rounded-sm border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-2 focus:ring-blue-500';

export const RADIO_CLASS =
  'h-4 w-4 border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-2 focus:ring-blue-500';

export const SECONDARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

export const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 min-h-[36px] px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

export const DANGER_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3 py-2 border border-red-300 dark:border-red-700 shadow-xs text-sm font-medium rounded-md text-red-700 dark:text-red-300 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/40 focus:outline-hidden focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

/** Callout tones: text colours meet 4.5:1 on their own background in both themes. */
export const CALLOUT_CLASS = {
  info: 'rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 p-3 text-sm text-blue-800 dark:text-blue-200',
  warning:
    'rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-200',
  danger:
    'rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-800 dark:text-red-200',
  success:
    'rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 p-3 text-sm text-green-800 dark:text-green-200'
};
