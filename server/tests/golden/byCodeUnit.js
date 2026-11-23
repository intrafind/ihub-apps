// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The order of the goldens, said out loud: by the string form, UTF-16 code unit
 * by code unit. It is the order `sort()` has without a comparator, so the
 * goldens keep their bytes; `localeCompare` would give another order, and one
 * that depends on the locale of the machine.
 *
 * @param {*} a
 * @param {*} b
 * @returns {number}
 */
export const byCodeUnit = (a, b) => {
  const x = String(a);
  const y = String(b);
  if (x < y) return -1;
  return x > y ? 1 : 0;
};
