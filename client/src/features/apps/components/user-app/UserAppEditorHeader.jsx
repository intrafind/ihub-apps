// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import MoreActionsMenu from '../../../admin/components/MoreActionsMenu';
import { SECONDARY_BUTTON_CLASS } from '../../../admin/components/formStyles';
import { DEFAULT_APP_COLOR, DEFAULT_APP_ICON } from '../../../../../../shared/appDefaults.js';

const CHIP_CLASS =
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border';
const CHIP_TONE = {
  neutral:
    'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
  shared:
    'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-200',
  warning:
    'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200'
};
const LINK_CLASS =
  'rounded-sm text-sm font-medium text-admin-accent dark:text-admin-accent-fg-dark underline hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent';

/**
 * The head of the editor of a personal app: the app's tile, its name, the
 * state chip ("Only you", "Shared with 5 people", "Offered to Ben Koch", …)
 * and the actions that concern the whole app. The chip is text, never colour
 * alone.
 *
 * The component knows no path and makes no request. An action is offered
 * when its callback is passed: the page passes it only for what the server
 * says the caller may do (`permissions`).
 *
 * @param {object} props
 * @param {string} props.name - The name in the reader's language.
 * @param {string} [props.icon] - An icon name.
 * @param {string} [props.color] - `#RRGGBB`.
 * @param {{key: string, values?: object, tone: string}} props.chip - The result of `userAppStateChip`.
 * @param {boolean} props.testOpen - The test panel is open.
 * @param {() => void} [props.onToggleTest]
 * @param {() => void} [props.onShare]
 * @param {() => void} [props.onOpenApp]
 * @param {() => void} [props.onPublish] - P12's entry; see the mount point below.
 * @param {() => void} [props.onHandOver]
 * @param {() => void} [props.onWithdraw] - Shown beside the chip while an offer is open.
 * @param {() => void} [props.onDuplicate]
 * @param {() => void} [props.onDelete]
 * @param {{ current: HTMLElement|null }} [props.headingRef] - The heading, for a focus that
 *   lost its control.
 * @returns {JSX.Element}
 */
function UserAppEditorHeader({
  name,
  icon,
  color,
  chip,
  testOpen,
  onToggleTest,
  onShare,
  onOpenApp,
  onPublish,
  onHandOver,
  onWithdraw,
  onDuplicate,
  onDelete,
  headingRef
}) {
  const { t } = useTranslation();
  const moreItems = [
    onOpenApp && { id: 'open', label: t('admin.apps.openApp'), onSelect: onOpenApp },
    // P12 MOUNT POINT (publish): the "Publish" entry of the editor menu. It is
    // shown when the page passes `onPublish`, which it does once P12's dialog
    // is mounted there and the server says `permissions.canPublish`.
    onPublish && { id: 'publish', label: t('userApps.publish.action'), onSelect: onPublish },
    onHandOver && { id: 'handOver', label: t('userApps.transfer.action'), onSelect: onHandOver },
    onDuplicate && {
      id: 'duplicate',
      label: t('userApps.list.menu.duplicate'),
      onSelect: onDuplicate
    },
    onDelete && {
      id: 'delete',
      label: t('userApps.list.menu.delete'),
      onSelect: onDelete,
      destructive: true
    }
  ].filter(Boolean);

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
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="rounded-sm text-2xl font-semibold text-gray-900 dark:text-gray-100 break-words focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent"
          >
            {name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              role="status"
              data-testid="user-app-state"
              className={`${CHIP_CLASS} ${CHIP_TONE[chip.tone] || CHIP_TONE.neutral}`}
            >
              {t(chip.key, chip.values)}
            </span>
            {onWithdraw && (
              <button type="button" onClick={onWithdraw} className={LINK_CLASS}>
                {t('userApps.transfer.withdraw')}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        {onShare && (
          <button type="button" onClick={onShare} className={SECONDARY_BUTTON_CLASS}>
            <Icon name="share" size="sm" aria-hidden="true" />
            {t('userApps.list.menu.share')}
          </button>
        )}
        {onToggleTest && (
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
        )}
        {moreItems.length > 0 && (
          <MoreActionsMenu items={moreItems} label={t('admin.apps.edit.more')} />
        )}
      </div>
    </div>
  );
}

export default UserAppEditorHeader;
