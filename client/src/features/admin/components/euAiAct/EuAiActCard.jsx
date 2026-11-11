// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';

/**
 * One card of the page: a labelled section with its own heading, so a screen
 * reader lists the four topics and each card can fail on its own.
 *
 * @param {Object} props
 * @param {string} props.id - Anchor id (e.g. `watermark-keys`)
 * @param {string} props.title
 * @param {React.ReactNode} [props.description]
 * @param {React.ReactNode} [props.actions] - Header buttons
 */
export default function EuAiActCard({ id, title, description, actions, children }) {
  const headingId = `${useId()}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-4 bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 overflow-hidden"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="p-6">{children}</div>
    </section>
  );
}
