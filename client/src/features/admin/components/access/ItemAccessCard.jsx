// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import AccessTools from './AccessTools';
import { formatSentence, groupNamer, primaryRoute, routeSentence } from './accessExplanation';
import { useItemAccess } from './useItemAccess';

/** The audience sentence, by case. Written out for the i18n test. */
const AUDIENCE_KEYS = {
  everyone: 'admin.access.card.audienceEveryone',
  signedIn: 'admin.access.card.audienceSignedIn',
  anonymous: 'admin.access.card.audienceAnonymous',
  groups: 'admin.access.card.audienceGroups',
  none: 'admin.access.card.audienceNone'
};

/**
 * Who the item reaches, as one sentence.
 *
 * @param {object} view - The access view
 * @param {string[]} teamNames - Names of the effective groups that are teams
 * @returns {{key: string, values: object}}
 */
export function audienceSentence(view, teamNames) {
  const audience = view?.audience || {};
  if (audience.allSignedIn && audience.anonymous)
    return { key: AUDIENCE_KEYS.everyone, values: {} };
  if (audience.allSignedIn) return { key: AUDIENCE_KEYS.signedIn, values: {} };
  if (audience.anonymous) {
    return { key: AUDIENCE_KEYS.anonymous, values: { groups: teamNames.join(', ') } };
  }
  if (teamNames.length > 0) {
    return { key: AUDIENCE_KEYS.groups, values: { groups: teamNames.join(', ') } };
  }
  return { key: AUDIENCE_KEYS.none, values: {} };
}

/**
 * "Who can use this model": the groups that grant the model, by name or
 * through `*` and inheritance, said in words; the restrict helper while a
 * wildcard covers the model; and the access check.
 *
 * Read-only for the groups themselves: granting a model by name to one group
 * is done in the group editor or as part of "Restrict access".
 *
 * @param {object} props
 * @param {'models'} props.type
 * @param {string} props.id
 * @param {string} props.itemName
 * @param {string} [props.className]
 * @returns {JSX.Element}
 */
function ItemAccessCard({ type, id, itemName, className = '' }) {
  const { t } = useTranslation();
  const { view, loading, error, reload, setView } = useItemAccess({ type, id });

  const rows = useMemo(() => (Array.isArray(view?.groups) ? view.groups : []), [view]);
  const nameOf = useMemo(() => groupNamer(rows), [rows]);
  const effectiveTeams = rows.filter(row => row.effective && !row.implicit);
  const audience = view
    ? audienceSentence(
        view,
        effectiveTeams.map(row => row.name)
      )
    : null;

  return (
    <div
      className={`bg-white dark:bg-gray-800 shadow-sm rounded-lg ${className}`.trim()}
      data-testid="item-access-card"
    >
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {t('admin.access.card.title')}
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('admin.access.card.description')}
        </p>
      </div>
      <div className="px-6 py-4 space-y-4">
        {loading && !view && (
          <p className="flex items-center text-sm text-gray-600 dark:text-gray-400">
            <Icon name="refresh" className="h-4 w-4 mr-2 animate-spin" />
            {t('admin.access.card.loading')}
          </p>
        )}
        {error && !view && (
          <div className="text-sm text-red-700 dark:text-red-300" role="alert">
            <p>
              {t('admin.access.card.loadError')} {error}
            </p>
            <button
              type="button"
              onClick={() => void reload()}
              className="mt-2 text-sm font-medium text-indigo-700 hover:text-indigo-600 dark:text-indigo-400"
            >
              {t('admin.contentAccess.retry')}
            </button>
          </div>
        )}
        {view && (
          <>
            <p
              className="text-sm font-medium text-gray-900 dark:text-gray-100"
              data-testid="item-access-audience"
            >
              {t(audience.key, audience.values)}
            </p>
            {effectiveTeams.length > 0 && (
              <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
                {effectiveTeams.map(row => {
                  const route = primaryRoute(row);
                  return (
                    <li key={row.id} className="flex items-start">
                      <Icon name="users" className="h-4 w-4 mr-1.5 mt-0.5 shrink-0" />
                      <span>
                        {route
                          ? formatSentence(
                              routeSentence({ groupName: row.name, route, type, nameOf }),
                              t
                            )
                          : row.name}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <AccessTools
              type={type}
              id={id}
              itemName={itemName}
              view={view}
              onRestricted={setView}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default ItemAccessCard;
