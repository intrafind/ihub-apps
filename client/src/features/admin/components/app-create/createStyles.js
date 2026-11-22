// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Class names the screens of the "New app" page share beyond
 * `features/admin/components/formStyles.js`.
 */

/** A button that reads as a link: "Try again", "Start over", "Back". */
export const LINK_BUTTON_CLASS =
  'rounded-sm text-sm font-medium text-admin-accent dark:text-admin-accent-fg-dark underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

/** The message under a field that needs the author's attention. */
export const FIELD_ERROR_CLASS = 'mt-1 text-sm text-red-700 dark:text-red-300';

/**
 * A field's border while it needs the author's attention: the class the admin
 * forms share (`client/src/App.css`), which wins over the field's own border.
 */
export const INVALID_INPUT_CLASS = 'admin-form-error-field';

/** A button that opens or closes a part of the screen ("More details"). */
export const DISCLOSURE_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark';

/**
 * The grid of start cards (templates, "Copy an existing app"). Equal rows
 * (`auto-rows-fr`) and full-height cards give every card the same size.
 */
export const CARD_GRID_CLASS = 'grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3';
