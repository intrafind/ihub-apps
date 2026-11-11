// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';

const PAGE = 5;

export function formatWho(actor) {
  if (!actor) return '';
  return actor.name && actor.name !== actor.id ? `${actor.name} (${actor.id})` : actor.id;
}

function When({ value }) {
  const date = new Date(value);
  return (
    <time dateTime={value} title={value}>
      {Number.isNaN(date.getTime()) ? value : date.toLocaleString()}
    </time>
  );
}

function Reason({ text }) {
  const { t } = useTranslation();
  if (!text) {
    return (
      <span className="text-gray-600 dark:text-gray-400">
        {t('admin.euAiAct.master.noReason', 'No reason given')}
      </span>
    );
  }
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}

function Event({ entry }) {
  const { t } = useTranslation();
  return entry.enabled ? (
    <Badge tone="info" icon={<Icon name="shield-check" size="sm" />} size="sm">
      {t('admin.euAiAct.master.evOn', 'Switched on')}
    </Badge>
  ) : (
    <Badge tone="warning" icon={<Icon name="exclamation-triangle" size="sm" />} size="sm">
      {t('admin.euAiAct.master.evOff', 'Switched off')}
    </Badge>
  );
}

/**
 * The history of the switch, newest first, closed by default. A table from `sm`,
 * stacked entries below it. Read-only: nothing here can be edited or deleted.
 */
export default function ConformityHistory({ history = [] }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(PAGE);
  const rows = history.slice(0, shown);
  return (
    <details className="mt-4" data-testid="conformity-history">
      <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-gray-100 focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm">
        {t('admin.euAiAct.master.history', 'History ({{count}})', { count: history.length })}
      </summary>
      {history.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {t('admin.euAiAct.master.noHistory', 'No changes recorded yet.')}
        </p>
      ) : (
        <>
          <table className="mt-3 hidden w-full text-left text-sm sm:table">
            <caption className="sr-only">
              {t(
                'admin.euAiAct.master.historyCaption',
                'Changes of the EU AI Act master switch, newest first'
              )}
            </caption>
            <thead className="text-xs text-gray-600 dark:text-gray-400">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('admin.euAiAct.master.event', 'Event')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('admin.euAiAct.master.who', 'Who')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('admin.euAiAct.master.when', 'When')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t('admin.euAiAct.master.reason', 'Reason')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700 text-gray-900 dark:text-gray-100">
              {rows.map(entry => (
                <tr key={`${entry.changedAt}-${entry.enabled}`} className="align-top">
                  <td className="py-2 pr-3">
                    <Event entry={entry} />
                  </td>
                  <td className="py-2 pr-3">{formatWho(entry.changedBy)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <When value={entry.changedAt} />
                  </td>
                  <td className="py-2">
                    <Reason text={entry.reason} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-3 space-y-3 sm:hidden">
            {rows.map(entry => (
              <li
                key={`${entry.changedAt}-${entry.enabled}`}
                className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-sm text-gray-900 dark:text-gray-100"
              >
                <Event entry={entry} />
                <p className="mt-2">{formatWho(entry.changedBy)}</p>
                <p className="text-gray-600 dark:text-gray-400">
                  <When value={entry.changedAt} />
                </p>
                <p className="mt-1">
                  <Reason text={entry.reason} />
                </p>
              </li>
            ))}
          </ul>
          {history.length > shown && (
            <button
              type="button"
              onClick={() => setShown(shown + PAGE)}
              className="mt-3 text-sm font-medium text-indigo-700 dark:text-indigo-300 underline focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
            >
              {t('admin.euAiAct.master.loadMore', 'Load more')}
            </button>
          )}
        </>
      )}
    </details>
  );
}
