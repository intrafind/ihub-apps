// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createElement } from 'react';
import { namedList } from './confirmText';

/**
 * Whether an item changes state when a bulk toggle sets `enable`.
 *
 * @param {{ enabled?: boolean }} item
 * @param {boolean} enable - The target state.
 * @returns {boolean}
 */
const changesState = (item, enable) => (enable ? item.enabled === false : item.enabled !== false);

/**
 * A stable key for every name. Two items may share a name; the second one
 * gets its occurrence number.
 *
 * @param {string[]} names
 * @returns {Array<{ key: string, name: string }>}
 */
function keyedNames(names) {
  const seen = new Map();
  return names.map(name => {
    const occurrence = (seen.get(name) ?? 0) + 1;
    seen.set(name, occurrence);
    return { key: `${name}#${occurrence}`, name };
  });
}

/**
 * The names of every affected item as a list that scrolls on its own, so a
 * long list never pushes the dialog's buttons out of view. It can be reached
 * and scrolled with the keyboard.
 *
 * @param {string[]} names
 * @param {string} label - Accessible name of the list.
 * @returns {React.ReactElement}
 */
function scrollableNames(names, label) {
  return createElement(
    'ul',
    {
      key: 'names',
      tabIndex: 0,
      'aria-label': label,
      className:
        'mt-3 max-h-60 overflow-y-auto list-disc space-y-1 pl-5 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500'
    },
    keyedNames(names).map(({ key, name }) => createElement('li', { key }, name))
  );
}

/**
 * The confirmation for "Enable all" / "Disable all" on the Apps, Models and
 * Prompts lists (AI-B2): how many items change state, which ones (first five
 * by name), and that users see the change right away. When nothing would
 * change, the dialog is blocked with a reason instead of offering a no-op.
 *
 * With `wording`, the list has words of its own (Apps: "Publish all"). The
 * confirmation then names every affected item, not only the first five, and
 * `affected` tells the caller which items to send: exactly the ones listed.
 *
 * @param {Object} options
 * @param {Array<{ enabled?: boolean }>} options.items - The items the action covers. Without
 *   `wording` that is the whole list (not just the filtered view; the server toggles `*`).
 * @param {boolean} options.enable - true for "Enable all", false for "Disable all".
 * @param {string} options.itemsLabel - Plural noun for the items, e.g. "apps" (translated).
 * @param {(item: Object) => string} options.getName - Display name of an item.
 * @param {(key: string, options?: Object) => string} options.t - i18next `t`.
 * @param {React.ReactNode[]} [options.extraConsequences] - Appended after the names
 *   (e.g. the default-model consequence on Models).
 * @param {{ title: string, confirmLabel: string, message: (count: number) => string,
 *   nothingToChange: string }} [options.wording] - The list's own texts: the dialog title, the
 *   verb on the confirm button, the sentence above the names for `count` affected items, and
 *   the reason shown when no item would change.
 * @returns {{ title: string, message: React.ReactNode, consequences: React.ReactNode[],
 *   confirmLabel: string, danger: boolean, blocked?: { reason: string }, affected: Object[] }}
 */
export function buildBulkToggleConfirm({
  items,
  enable,
  itemsLabel,
  getName,
  t,
  extraConsequences = [],
  wording
}) {
  const total = items.length;
  const affected = items.filter(item => changesState(item, enable));
  const count = affected.length;
  const title =
    wording?.title ??
    (enable
      ? t('admin.confirm.bulk.enableTitle', {
          items: itemsLabel,
          defaultValue: 'Enable all {{items}}?'
        })
      : t('admin.confirm.bulk.disableTitle', {
          items: itemsLabel,
          defaultValue: 'Disable all {{items}}?'
        }));
  const confirmLabel =
    wording?.confirmLabel ??
    (enable
      ? t('admin.common.enableAll', 'Enable All')
      : t('admin.common.disableAll', 'Disable All'));

  if (count === 0) {
    const reason =
      wording?.nothingToChange ??
      (enable
        ? t('admin.confirm.bulk.nothingToEnable', {
            total,
            items: itemsLabel,
            defaultValue: 'All {{total}} {{items}} are already enabled.'
          })
        : t('admin.confirm.bulk.nothingToDisable', {
            total,
            items: itemsLabel,
            defaultValue: 'All {{total}} {{items}} are already disabled.'
          }));
    return { title, confirmLabel, danger: false, consequences: [], blocked: { reason }, affected };
  }

  if (wording) {
    return {
      title,
      message: [
        createElement('p', { key: 'message' }, wording.message(count)),
        scrollableNames(affected.map(getName), title)
      ],
      consequences: [...extraConsequences],
      confirmLabel,
      danger: !enable,
      affected
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
    danger: !enable,
    affected
  };
}

export default buildBulkToggleConfirm;

/** How many IDs, and how many characters of IDs, one request path carries at most. */
const PATH_ID_LIMIT = 50;
const PATH_ID_CHARS = 2000;

/**
 * Splits a list of IDs into parts that each fit into one request path
 * (`/admin/apps/a,b,c/_toggle`). A path with every ID of a large installation
 * exceeds what a reverse proxy (8 KB by default) and Node (16 KB) accept, and
 * the whole request is then refused.
 *
 * @param {string[]} ids
 * @param {{ maxIds?: number, maxChars?: number }} [limits]
 * @returns {string[][]} The IDs in their order, in parts of at most `maxIds`
 *   IDs and `maxChars` characters when joined with commas. An ID longer than
 *   `maxChars` is a part of its own.
 */
export function chunkIdsForPath(ids, { maxIds = PATH_ID_LIMIT, maxChars = PATH_ID_CHARS } = {}) {
  const parts = [];
  let part = [];
  let chars = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    const length = encodeURIComponent(String(id)).length + 1;
    if (part.length > 0 && (part.length >= maxIds || chars + length > maxChars + 1)) {
      parts.push(part);
      part = [];
      chars = 0;
    }
    part.push(id);
    chars += length;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}
