// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PRIMARY_BUTTON_CLASS } from '../formStyles';
import { Pill, marketplaceLinkFor } from './IntegrationPills';

/**
 * One definition on the Catalog tab: name, version, compatibility, update
 * badge, source, description, the facts (protocol, sign-in, actions,
 * publisher, required iHub version) and **Install**. An incompatible
 * definition is greyed with Install disabled and the reason shown.
 *
 * @param {Object} props
 * @param {Object} props.item - a definition as `GET /api/admin/integrations/catalog` lists it
 * @param {(definitionId: string) => void} props.onInstall - opens the install dialog
 */
function CatalogTile({ item, onInstall }) {
  const { t } = useTranslation();
  return (
    <li
      className={`bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-5 flex flex-col ${
        item.compatible === false ? 'opacity-60' : ''
      }`}
      data-testid="catalog-card"
      data-compatible={item.compatible === false ? 'false' : 'true'}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {item.name}
          <span className="ml-2 font-mono text-xs font-normal text-gray-500 dark:text-gray-400">
            v{item.version}
          </span>
        </h3>
        <div className="flex flex-wrap justify-end gap-1">
          {item.compatible === false && (
            <Pill tone="red" title={item.statusReason || undefined}>
              {t('admin.integrationCatalog.status.incompatible', 'Incompatible')}
            </Pill>
          )}
          {item.update?.compatible && (
            <Link
              to={marketplaceLinkFor(item.id)}
              className="inline-flex rounded-full focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <Pill tone="orange">
                {t(
                  'admin.integrationCatalog.status.updateAvailable',
                  'Update to v{{version}} available',
                  { version: item.update.latestVersion }
                )}
              </Pill>
            </Link>
          )}
          <Pill tone={item.source === 'installed' ? 'blue' : 'gray'}>
            {item.source === 'installed'
              ? t('admin.integrationCatalog.source.installed', 'From registry')
              : t('admin.integrationCatalog.source.shipped', 'Shipped')}
          </Pill>
        </div>
      </div>
      {item.compatible === false && item.statusReason && (
        <p
          className="mt-2 text-xs text-red-700 dark:text-red-400"
          data-testid="incompatible-reason"
        >
          {t('admin.integrationCatalog.catalogIncompatible', 'Cannot be installed: {{reason}}.', {
            reason: item.statusReason
          })}
        </p>
      )}
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 flex-1">{item.description}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
        <dt>{t('admin.integrationCatalog.facts.protocol', 'Protocol')}</dt>
        <dd className="font-mono">{item.protocol}</dd>
        <dt>{t('admin.integrationCatalog.facts.signIn', 'Sign-in')}</dt>
        <dd>
          {(item.authModes || [])
            .map(m => t(`admin.integrationCatalog.authModes.short.${m}`, m))
            .join(', ')}
        </dd>
        <dt>{t('admin.integrationCatalog.facts.actions', 'Actions')}</dt>
        <dd>{item.actionCount}</dd>
        <dt>{t('admin.integrationCatalog.facts.publisher', 'Publisher')}</dt>
        <dd>{item.publisher?.name || '—'}</dd>
        {item.requires && (
          <>
            <dt>{t('admin.integrationCatalog.facts.compatibility', 'Needs')}</dt>
            <dd className="font-mono">iHub {item.requires}</dd>
          </>
        )}
      </dl>
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {item.runsCode && (
            <Pill tone="yellow">
              {t('admin.integrationCatalog.runsCode', 'Runs code on this server')}
            </Pill>
          )}{' '}
          {item.installedInstances?.length
            ? t('admin.integrationCatalog.installedCount', '{{count}} installed', {
                count: item.installedInstances.length
              })
            : t('admin.integrationCatalog.notInstalled', 'Not installed')}
        </span>
        <button
          type="button"
          className={PRIMARY_BUTTON_CLASS}
          disabled={!item.supported || item.compatible === false}
          title={
            item.compatible === false
              ? item.statusReason || undefined
              : item.supported
                ? undefined
                : t('admin.integrationCatalog.unsupportedShort', 'Protocol not supported yet')
          }
          aria-label={t('admin.integrations.catalog.installAria', 'Install {{name}}', {
            name: item.name
          })}
          onClick={() => onInstall(item.id)}
        >
          {t('admin.integrationCatalog.install', 'Install')}
        </button>
      </div>
    </li>
  );
}

export default CatalogTile;
