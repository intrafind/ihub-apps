// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Whether an element's content is wider than the element, kept up to date
 * while the window or the element resizes.
 *
 * @param {React.RefObject<HTMLElement>} ref
 * @returns {boolean}
 */
function useHorizontalOverflow(ref) {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth);
    if (typeof ResizeObserver === 'undefined') {
      const frame = requestAnimationFrame(measure);
      window.addEventListener('resize', measure);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', measure);
      };
    }
    // Reports the initial sizes too. The table is observed as well, because
    // new results can widen it while the frame keeps its size.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [ref]);
  return overflows;
}

/**
 * The people a test search found, mapped the way the tools return them. Only
 * fields that have a value in at least one result get a column, so the table
 * shows exactly which fields leave the directory.
 *
 * A wide table scrolls sideways; while it does, its frame is a labelled region
 * in the Tab order, so keyboard users can scroll it with the arrow keys
 * (WCAG 2.1.1).
 *
 * @param {Object} props
 * @param {Array<Object>} props.results - `Person` objects
 * @param {string[]} props.fields - Mapped person fields, in display order
 */
function PersonResultsTable({ results, fields }) {
  const { t } = useTranslation();
  const frameRef = useRef(null);
  const scrollable = useHorizontalOverflow(frameRef);
  const hasValue = value => value !== null && value !== undefined && value !== '';
  const columns = fields.filter(field => results.some(person => hasValue(person?.[field])));
  const title = t('admin.peopleDirectories.test.resultsTitle', 'Mapped results ({{count}})', {
    count: results.length
  });

  if (results.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('admin.peopleDirectories.test.noResults', 'The sample search found nobody.')}
      </p>
    );
  }

  return (
    <div
      ref={frameRef}
      role={scrollable ? 'region' : undefined}
      aria-label={scrollable ? title : undefined}
      tabIndex={scrollable ? 0 : undefined}
      className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
    >
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
        <caption className="px-3 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </caption>
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {columns.map(field => (
              <th
                key={field}
                scope="col"
                className="px-3 py-2 text-left text-xs font-semibold text-gray-700 dark:text-gray-300 whitespace-nowrap"
              >
                {t(`admin.peopleDirectories.fields.${field}`, field)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700 bg-white dark:bg-gray-800">
          {results.map(person => (
            <tr key={person?.personId ?? JSON.stringify(person)}>
              {columns.map(field => (
                <td
                  key={field}
                  className="px-3 py-2 align-top text-gray-900 dark:text-gray-100"
                  title={field === 'name' ? person?.personId : undefined}
                >
                  {hasValue(person?.[field]) ? String(person[field]) : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default PersonResultsTable;
