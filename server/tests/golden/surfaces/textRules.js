// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text rules the surfaces hand to the normaliser (`textRules` of a case's
 * config): a date that is written in a form of its own, replaced by a word.
 *
 * This module imports nothing of the server, so a rule can be tested against
 * the function of the product that writes the text (`textRules.test.js`).
 *
 * @module tests/golden/surfaces/textRules
 */

/**
 * The chat of a scheduled run is named `<task> · <when>`, and `<when>` is what
 * `formatInstant` (`services/scheduler/schedule.js`) writes: weekday, day,
 * month, year and time, in the language of the task.
 *
 * The rule takes the words as they come. The short name of a month is not
 * three letters long in every month (`Sept` in en-GB) and ends with a full
 * stop in German (`Sept.`, and `Fr.` for the weekday, `20.` for the day).
 *
 * @type {{pattern: RegExp, replace: string}}
 */
export const RUN_CHAT_TITLE_RULE = Object.freeze({
  pattern: / · \p{L}+\.?, \d{1,2}\.? \p{L}+\.? \d{4}, \d{2}:\d{2}$/u,
  replace: ' · <when>'
});
