// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** Button looks of Settings → Integrations (the Connect card's primary look, light and dark). */
const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-60';

export const PRIMARY_BUTTON = `${BASE} bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-indigo-500`;

export const SECONDARY_BUTTON = `${BASE} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 focus-visible:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700`;

export const DANGER_BUTTON = `${BASE} border border-red-300 bg-white text-red-700 hover:bg-red-50 focus-visible:ring-red-500 dark:border-red-700 dark:bg-gray-800 dark:text-red-300 dark:hover:bg-red-900/40`;
