// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import { actionTitle, integrationFactRows, sideEffectTone } from './integrationItemFacts';

/**
 * The four fixed facts of a marketplace integration item (sign-in, effect,
 * where it runs, actions) as a two-column definition list. Renders nothing
 * without facts.
 *
 * @param {Object} props
 * @param {Object|null} [props.facts] - The item's `facts` (see `integrationItemFacts.js`)
 * @param {string} [props.className] - Extra classes (spacing)
 * @returns {JSX.Element|null}
 */
export function MarketplaceIntegrationFacts({ facts, className = '' }) {
  const { t } = useTranslation();
  const rows = integrationFactRows(facts, t);
  if (rows.length === 0) return null;
  return (
    <dl
      className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400 ${className}`}
      data-testid="integration-facts"
    >
      {rows.map(row => (
        <div key={row.id} className="contents" data-testid={`integration-fact-${row.id}`}>
          <dt className="text-gray-500 dark:text-gray-400">{row.label}</dt>
          <dd className="text-gray-900 dark:text-gray-200 truncate">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The detail section of an integration item: its facts and the actions it
 * declares, each with its side effect as a badge (the labels of Admin →
 * Integrations). An MCP or A2A integration lists its actions only at
 * runtime, which the section says instead of an empty list.
 *
 * @param {Object} props
 * @param {Object|null} [props.facts] - The item's `facts`, with `actions`
 * @returns {JSX.Element}
 */
function MarketplaceIntegrationSection({ facts }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language?.split('-')[0] || 'en';
  const actions = Array.isArray(facts?.actions) ? facts.actions : [];

  return (
    <section data-testid="integration-facts-section">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
        {t('admin.marketplace.integrationFacts.title', 'Integration facts')}
      </h3>
      {!facts ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            'admin.marketplace.integrationFacts.unavailable',
            'The definition could not be read from the registry, so its facts are not shown.'
          )}
        </p>
      ) : (
        <>
          <MarketplaceIntegrationFacts
            facts={facts}
            className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 text-sm"
          />
          <h4 className="mt-4 mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            {t('admin.integrationCatalog.facts.actions', 'Actions')}
          </h4>
          {actions.length > 0 ? (
            <ul
              className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg"
              data-testid="integration-actions"
            >
              {actions.map(action => (
                <li
                  key={action.name}
                  className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block text-gray-900 dark:text-white truncate">
                      {actionTitle(action, lang)}
                    </span>
                    <span className="block font-mono text-xs text-gray-500 dark:text-gray-400 truncate">
                      {action.name}
                    </span>
                  </span>
                  <Badge tone={sideEffectTone(action.sideEffect)} shape="rounded">
                    {t(
                      `admin.integrationCatalog.sideEffect.${action.sideEffect || 'unknown'}`,
                      action.sideEffect || 'unknown'
                    )}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : facts.actionCount === null || facts.actionCount === 0 ? (
            // A positive count without a list (the browse item when the detail
            // could not be loaded) shows nothing rather than "no actions".
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {facts.actionCount === null
                ? t(
                    'admin.marketplace.integrationFacts.actionsDynamicHint',
                    'The server lists its actions when iHub connects to it; install and test the integration to see them.'
                  )
                : t(
                    'admin.marketplace.integrationFacts.noActions',
                    'This integration declares no actions.'
                  )}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

export default MarketplaceIntegrationSection;
