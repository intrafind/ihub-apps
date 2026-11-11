// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

/**
 * Classes for a chip label that stays out of the way until the chip is hovered
 * or focused. The text is clipped, not removed, so a screen reader still reads
 * it and the chip keeps its accessible name.
 */
export const HOVER_LABEL =
  'max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-150 group-hover:ml-1 group-hover:max-w-[10rem] group-hover:opacity-100 group-focus-within:ml-1 group-focus-within:max-w-[10rem] group-focus-within:opacity-100';

/**
 * Splits chips into the ones that fit and a "+N" chip for the rest, so a chat
 * with many things switched on cannot push the chips over each other or over
 * the model selector.
 *
 * @param {Object} props
 * @param {{key: string, label: string, node: import('react').ReactNode}[]} props.items
 * @param {number} [props.max=3] - Chips shown before the rest fold into "+N"
 * @param {string} [props.className] - Classes of the "+N" chip
 */
export default function ChipOverflow({ items, max = 3, className = '' }) {
  const { t } = useTranslation();
  // A "+1" chip is no smaller than the chip it hides: show that one instead.
  const visible = items.length > max ? items.slice(0, max - 1) : items;
  const hidden = items.slice(visible.length);
  const names = hidden.map(item => item.label).join(', ');

  return (
    <>
      {visible.map(item => item.node)}
      {hidden.length > 0 && (
        <span
          role="note"
          data-testid="chip-overflow"
          aria-label={t('chat.chips.more', '{{count}} more: {{names}}', {
            count: hidden.length,
            names
          })}
          title={names}
          className={`shrink-0 cursor-default rounded-full px-2 py-1 text-xs font-medium tabular-nums ${className}`}
        >
          +{hidden.length}
        </span>
      )}
    </>
  );
}
