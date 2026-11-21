// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Preload for `record.mjs` (`node --import`): the process sees another date.
 * `GOLDEN_CLOCK_SHIFT_MS` is added to the clock, so the second process of the
 * determinism test records on a different day, in a different month and at a
 * different hour than the first. A golden that holds a date somewhere the
 * normaliser does not know about fails there today, not on the first of the
 * next month in CI.
 */
const shift = Number(process.env.GOLDEN_CLOCK_SHIFT_MS || 0);

if (shift) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...args);
    }

    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = ShiftedDate;
}
