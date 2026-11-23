// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The ID proposed for a clone of a model, prompt or workflow: `<id>-copy`, or
 * `<id>-copy-2`, `<id>-copy-3`, … when that one is taken. Pure.
 *
 * The admin can still change it before saving; the form checks it against
 * the existing IDs like any other.
 *
 * @param {string} id - The ID of the resource being cloned.
 * @param {Iterable<string>} [takenIds] - The IDs that exist already.
 * @returns {string}
 *
 * @example
 * copyId('gpt-4', ['gpt-4', 'gpt-4-copy']); // → 'gpt-4-copy-2'
 */
export function copyId(id, takenIds = []) {
  const taken = new Set(takenIds);
  const base = `${id || ''}-copy`;
  if (!taken.has(base)) return base;
  let number = 2;
  while (taken.has(`${base}-${number}`)) number += 1;
  return `${base}-${number}`;
}
