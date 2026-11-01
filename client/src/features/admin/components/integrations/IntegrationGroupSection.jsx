// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

/**
 * One group of the Installed or Catalog tab (`groupIntegrations`): a heading
 * with the count, a one-line description and the tiles in a grid.
 *
 * @param {Object} props
 * @param {Object} props.group - a group of `groupIntegrations` (`id`, `titleKey`, `items`, …)
 * @param {string} props.scope - `installed` or `catalog`, keeps heading ids unique per tab
 * @param {React.ReactNode} props.children - the tiles (`<li>` elements)
 */
function IntegrationGroupSection({ group, scope, children }) {
  const { t } = useTranslation();
  const headingId = `integration-group-${scope}-${group.id}`;
  return (
    <section aria-labelledby={headingId} data-testid="integration-group" data-group={group.id}>
      <div className="mb-3">
        <h2
          id={headingId}
          className="text-sm font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300"
        >
          {t(group.titleKey, group.titleDefault)}
          <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
            ({group.items.length})
          </span>
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t(group.descriptionKey, group.descriptionDefault)}
        </p>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{children}</ul>
    </section>
  );
}

export default IntegrationGroupSection;
