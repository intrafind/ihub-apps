// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The kill points `KILLPOINTS.md` lists, read from its two tables. The harness
 * refuses a name that is not listed (a typo would make a test wait for a kill
 * that never comes), and `server/tests/killPoint-inventory.test.js` compares
 * the tables with the call sites.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KILLPOINTS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'KILLPOINTS.md'
);

/** The headings of the two tables. */
export const SERVER_SECTION = 'In the server';
export const FIXTURE_SECTION = 'In the fixture server of the harness';

/**
 * The rows of the tables of a kill point list, by section.
 *
 * @param {string} [markdown] - The text of `KILLPOINTS.md`
 * @returns {Array<{section: string, name: string, file: string}>}
 */
export function documentedKillPoints(markdown = fs.readFileSync(KILLPOINTS_FILE, 'utf8')) {
  const rows = [];
  let section = '';
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    const row = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (row) rows.push({ section, name: row[1], file: row[2] });
  }
  return rows;
}

/**
 * The names a harness may arm.
 *
 * @returns {string[]}
 */
export function documentedKillPointNames() {
  return documentedKillPoints().map(row => row.name);
}
