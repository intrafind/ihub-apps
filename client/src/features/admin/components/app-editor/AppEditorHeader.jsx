// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import MoreActionsMenu from '../MoreActionsMenu';
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import { DEFAULT_APP_COLOR, DEFAULT_APP_ICON } from '../../../../../../shared/appDefaults.js';

const STATUS_CLASS =
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium';
const STATUS_TONE = {
  published:
    'border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-200',
  notPublished:
    'border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
};
const DOT_CLASS = {
  published: 'h-2 w-2 rounded-full bg-green-600 dark:bg-green-400',
  notPublished: 'h-2 w-2 rounded-full border border-gray-500 dark:border-gray-400'
};

/**
 * The head of the app editor: the app's tile, its name, its ID and whether it
 * is published, with the actions that concern the whole app.
 *
 * "Publish" is offered while the app is not published and "Unpublish", under
 * "More", while it is: the header has one control that changes the published
 * state at a time. The component knows no path and makes no request; every
 * action is a callback.
 *
 * The heading can take the focus (`headingRef`): "Publish" leaves the page
 * once the app is published, and the focus needs a place that stays.
 *
 * @param {object} props
 * @param {string} props.appId - The app's ID; it cannot be changed here.
 * @param {string} props.name - The name in the reader's language.
 * @param {string} [props.icon] - An icon name.
 * @param {string} [props.color] - `#RRGGBB`.
 * @param {boolean} props.published - The saved app is published.
 * @param {boolean} props.testOpen - The test panel is open.
 * @param {() => void} props.onToggleTest
 * @param {() => void} props.onPublish - Opens the publish dialog.
 * @param {() => void} props.onUnpublish - Opens the unpublish question.
 * @param {() => void} props.onOpenApp - Opens the app as users get it.
 * @param {boolean} [props.openAppDisabled=false] - The app cannot be opened now.
 * @param {() => void} props.onHistory
 * @param {() => void} props.onDownload
 * @param {() => void} props.onDuplicate
 * @param {{ current: HTMLElement|null }} [props.headingRef] - The heading, for a focus
 *   that lost its control.
 * @returns {JSX.Element}
 */
function AppEditorHeader({
  appId,
  name,
  icon,
  color,
  published,
  testOpen,
  onToggleTest,
  onPublish,
  onUnpublish,
  onOpenApp,
  openAppDisabled = false,
  onHistory,
  onDownload,
  onDuplicate,
  headingRef
}) {
  const { t } = useTranslation();
  const tone = published ? 'published' : 'notPublished';
  const moreItems = [
    {
      id: 'open',
      label: t('admin.apps.openApp'),
      onSelect: onOpenApp,
      disabled: openAppDisabled
    },
    { id: 'history', label: t('admin.apps.edit.history'), onSelect: onHistory },
    { id: 'download', label: t('common.download'), onSelect: onDownload },
    { id: 'duplicate', label: t('admin.apps.list.duplicate'), onSelect: onDuplicate },
    ...(published
      ? [{ id: 'unpublish', label: t('admin.apps.edit.unpublish.action'), onSelect: onUnpublish }]
      : [])
  ];

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-auto items-start gap-3">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white"
          style={{ backgroundColor: color || DEFAULT_APP_COLOR }}
          aria-hidden="true"
        >
          <Icon name={icon || DEFAULT_APP_ICON} size="lg" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="rounded-sm text-2xl font-semibold text-gray-900 dark:text-gray-100 break-words focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark"
            >
              {name || appId}
            </h1>
            <span
              role="status"
              data-testid="app-status"
              className={`${STATUS_CLASS} ${STATUS_TONE[tone]}`}
            >
              <span className={DOT_CLASS[tone]} aria-hidden="true" />
              {published ? t('admin.apps.status.published') : t('admin.apps.status.notPublished')}
            </span>
          </div>
          <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400 break-all">
            <span className="sr-only">{t('admin.apps.edit.appId')}: </span>
            <span data-testid="app-id">{appId}</span>
          </p>
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        {!published && (
          <button
            type="button"
            onClick={onPublish}
            className={`${PRIMARY_BUTTON_CLASS} w-full sm:w-auto`}
          >
            {t('admin.apps.edit.publish.action')}
          </button>
        )}
        <button
          type="button"
          onClick={onToggleTest}
          aria-expanded={testOpen}
          title={t('admin.apps.edit.testHint')}
          className={`${SECONDARY_BUTTON_CLASS} flex-auto sm:flex-none`}
        >
          <Icon name="beaker" size="sm" aria-hidden="true" />
          {testOpen ? t('admin.apps.edit.hideTest') : t('admin.apps.edit.test')}
        </button>
        <MoreActionsMenu items={moreItems} label={t('admin.apps.edit.more')} />
      </div>
    </div>
  );
}

export default AppEditorHeader;
