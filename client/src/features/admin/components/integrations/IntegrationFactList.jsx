// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

/**
 * The key facts of an installation (`installationFacts`) as a definition
 * list: a translated label and the value, URLs and ids in a monospace font,
 * a secret only as "set" / "not set".
 *
 * @param {Object} props
 * @param {import('./integrationFacts').InstallationFact[]} props.facts
 * @param {'tile'|'page'} [props.variant='tile'] - compact on a tile, roomier on the page
 */
function IntegrationFactList({ facts, variant = 'tile' }) {
  const { t } = useTranslation();
  if (!facts?.length) return null;
  const compact = variant === 'tile';
  return (
    <dl
      className={
        compact
          ? 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs'
          : 'grid grid-cols-1 sm:grid-cols-[12rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm'
      }
      data-testid="installation-facts"
    >
      {facts.map(fact => (
        <div key={fact.id} className="contents" data-fact={fact.id}>
          <dt className="text-gray-500 dark:text-gray-400">
            {t(fact.labelKey, fact.labelDefault)}
          </dt>
          <dd
            className={`min-w-0 ${compact ? 'truncate' : 'break-all'} ${fact.mono ? 'font-mono' : ''} ${
              fact.secret === 'unset'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-gray-800 dark:text-gray-200'
            }`}
            title={fact.text || undefined}
          >
            {fact.valueKey ? t(fact.valueKey, fact.valueDefault, fact.valueParams) : fact.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default IntegrationFactList;
