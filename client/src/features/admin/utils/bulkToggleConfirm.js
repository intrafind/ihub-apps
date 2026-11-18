// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { namedList } from './confirmText';

/**
 * The confirmation for "Enable all" / "Disable all" on the Apps, Models and
 * Prompts lists (AI-B2): how many items change state, which ones (first five
 * by name), and that users see the change right away. When nothing would
 * change, the dialog is blocked with a reason instead of offering a no-op.
 *
 * @param {Object} options
 * @param {Array<{ enabled?: boolean }>} options.items - All items of the list (not just the filtered view;
 *   the server toggles `*`).
 * @param {boolean} options.enable - true for "Enable all", false for "Disable all".
 * @param {string} options.itemsLabel - Plural noun for the items, e.g. "apps" (translated).
 * @param {(item: Object) => string} options.getName - Display name of an item.
 * @param {(key: string, options?: Object) => string} options.t - i18next `t`.
 * @param {React.ReactNode[]} [options.extraConsequences] - Appended after the names
 *   (e.g. the default-model consequence on Models).
 * @returns {{ title: string, message: string, consequences: React.ReactNode[], confirmLabel: string,
 *   danger: boolean, blocked?: { reason: string } }}
 */
export function buildBulkToggleConfirm({
  items,
  enable,
  itemsLabel,
  getName,
  t,
  extraConsequences = []
}) {
  const total = items.length;
  const affected = items.filter(item => (enable ? item.enabled === false : item.enabled !== false));
  const count = affected.length;
  const title = enable
    ? t('admin.confirm.bulk.enableTitle', {
        items: itemsLabel,
        defaultValue: 'Enable all {{items}}?'
      })
    : t('admin.confirm.bulk.disableTitle', {
        items: itemsLabel,
        defaultValue: 'Disable all {{items}}?'
      });
  const confirmLabel = enable
    ? t('admin.common.enableAll', 'Enable All')
    : t('admin.common.disableAll', 'Disable All');

  if (count === 0) {
    return {
      title,
      confirmLabel,
      danger: false,
      consequences: [],
      blocked: {
        reason: enable
          ? t('admin.confirm.bulk.nothingToEnable', {
              total,
              items: itemsLabel,
              defaultValue: 'All {{total}} {{items}} are already enabled.'
            })
          : t('admin.confirm.bulk.nothingToDisable', {
              total,
              items: itemsLabel,
              defaultValue: 'All {{total}} {{items}} are already disabled.'
            })
      }
    };
  }

  const message = enable
    ? t('admin.confirm.bulk.enableMessage', {
        count,
        total,
        items: itemsLabel,
        defaultValue:
          '{{count}} of {{total}} {{items}} are disabled now and will be enabled. Users with access see them right away:'
      })
    : t('admin.confirm.bulk.disableMessage', {
        count,
        total,
        items: itemsLabel,
        defaultValue:
          '{{count}} of {{total}} {{items}} are enabled now and will be disabled. Users lose access right away:'
      });

  return {
    title,
    message,
    consequences: [...namedList(affected.map(getName), t), ...extraConsequences],
    confirmLabel,
    danger: !enable
  };
}

export default buildBulkToggleConfirm;
