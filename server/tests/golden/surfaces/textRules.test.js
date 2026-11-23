// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The text rules of the surfaces, run against the function of the product
 * that writes the text. A rule that fits eleven months of the year is a golden
 * that fails in the twelfth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInstant } from '../../../services/scheduler/schedule.js';
import { createNormaliser } from '../normalise.js';
import { RUN_CHAT_TITLE_RULE } from './textRules.js';

const ZONES = ['UTC', 'Europe/Berlin', 'America/Los_Angeles'];

test('the title of the chat of a scheduled run is normalised in every month, in both languages', () => {
  const { normalise } = createNormaliser({ textRules: [RUN_CHAT_TITLE_RULE] });
  const seen = new Set();
  for (const language of ['en', 'de']) {
    for (let month = 0; month < 12; month++) {
      // A one-digit and a two-digit day, in two years, on different weekdays.
      for (const [year, day, hour] of [
        [2026, 3, 5],
        [2027, 10, 11],
        [2027, 28, 23]
      ]) {
        const instant = new Date(Date.UTC(year, month, day, hour, 7));
        for (const zone of ZONES) {
          const when = formatInstant(instant, zone, language);
          seen.add(when.replace(/\d/g, '0'));
          assert.equal(
            normalise(`Release watch · ${when}`),
            'Release watch · <when>',
            `"${when}" (${language}, ${zone}) is left in the title`
          );
        }
      }
    }
  }
  // The case the rule was first written without: a month whose short name has four letters.
  assert.equal(
    formatInstant(new Date(Date.UTC(2027, 8, 10, 9, 0)), 'Europe/Berlin', 'en'),
    'Fri, 10 Sept 2027, 11:00'
  );
  // The dates really came in more than one form, so the loop tested more than one.
  assert.ok(seen.size > 4, `only ${seen.size} forms of a date were tested`);
});

test('the rule replaces the date at the end of a title and nothing else', () => {
  const { normalise } = createNormaliser({ textRules: [RUN_CHAT_TITLE_RULE] });
  assert.deepEqual(
    normalise({
      title: 'Release watch · Fri, 10 Sept 2027, 11:00',
      // No date after the dot, a date in the middle, and a date that is not at the end.
      name: 'Release watch · weekly',
      note: 'Fri, 10 Sept 2027, 11:00 is when it ran',
      other: 'Release watch · Fri, 10 Sept 2027, 11:00 (late)'
    }),
    {
      name: 'Release watch · weekly',
      note: 'Fri, 10 Sept 2027, 11:00 is when it ran',
      other: 'Release watch · Fri, 10 Sept 2027, 11:00 (late)',
      title: 'Release watch · <when>'
    }
  );
});
