// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Class names shared by the admin pages. The project does not use
 * @tailwindcss/forms, so inputs set border, padding, colours and a visible
 * focus ring explicitly.
 *
 * Colours meet WCAG 1.4.11 (3:1 for a control's boundary): field borders use
 * the `admin-control-border` tokens (gray-500 light, 4.84:1 on white; gray-400
 * dark, 5.64:1 on the gray-800 card), and focus and primary actions use the
 * admin accent (indigo-600; indigo-400 on dark surfaces). See
 * `client/tailwind.css` for the tokens.
 */

export const INPUT_CLASS =
  'w-full rounded-md border border-admin-control-border dark:border-admin-control-border-dark bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs px-3 py-2 text-sm focus:outline-hidden focus:border-admin-accent focus:ring-2 focus:ring-admin-accent dark:focus:ring-admin-accent-fg-dark disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed';

export const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;

export const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

export const HELP_CLASS = 'mt-1 text-xs text-gray-600 dark:text-gray-400';

/** Native checkbox: `accent-color` tints it (border and text utilities do nothing on it). */
export const CHECKBOX_CLASS =
  'h-4 w-4 shrink-0 accent-admin-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-admin-accent';

export const RADIO_CLASS =
  'h-4 w-4 shrink-0 accent-admin-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-admin-accent';

export const SECONDARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-admin-accent dark:focus:ring-admin-accent-fg-dark focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

export const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 min-h-[36px] px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-admin-accent hover:bg-admin-accent-hover focus:outline-hidden focus:ring-2 focus:ring-admin-accent dark:focus:ring-admin-accent-fg-dark focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

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
