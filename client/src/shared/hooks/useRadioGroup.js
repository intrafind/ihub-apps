// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useRef } from 'react';

/** The step an arrow key takes through a radio group, or 0 for any other key. */
const stepOf = key =>
  key === 'ArrowRight' || key === 'ArrowDown'
    ? 1
    : key === 'ArrowLeft' || key === 'ArrowUp'
      ? -1
      : 0;

/**
 * The keyboard of a group of `role="radio"` buttons (WAI-ARIA radio group
 * pattern): one tab stop, on the checked radio or, with none checked, on the
 * first; the arrow keys move to the next or previous radio, wrap around and
 * select it.
 *
 * @param {object} options
 * @param {string[]} options.ids - The radios in their order.
 * @param {string|null|undefined} options.selected - The checked radio.
 * @param {(id: string) => void} options.onSelect
 * @returns {(id: string) => {role: 'radio', 'aria-checked': boolean, tabIndex: number,
 *   ref: (node: HTMLElement|null) => void, onClick: () => void,
 *   onKeyDown: (event: KeyboardEvent) => void}} The props of one radio.
 *
 * @example
 * const radio = useRadioGroup({ ids: ['all', 'mine'], selected: scope, onSelect: setScope });
 * return ids.map(id => <button key={id} type="button" {...radio(id)}>{id}</button>);
 */
export default function useRadioGroup({ ids, selected, onSelect }) {
  const nodesRef = useRef(new Map());
  const tabStop = ids.includes(selected) ? selected : ids[0];
  return useCallback(
    id => ({
      role: 'radio',
      'aria-checked': selected === id,
      tabIndex: id === tabStop ? 0 : -1,
      ref: node => {
        if (node) nodesRef.current.set(id, node);
        else nodesRef.current.delete(id);
      },
      onClick: () => onSelect(id),
      onKeyDown: event => {
        const step = stepOf(event.key);
        if (!step || ids.length === 0) return;
        event.preventDefault();
        const index = ids.indexOf(id);
        const next = ids[(index + step + ids.length) % ids.length];
        onSelect(next);
        nodesRef.current.get(next)?.focus();
      }
    }),
    [ids, selected, tabStop, onSelect]
  );
}
