// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The security.txt the documentation site publishes (docs/.well-known/security.txt,
 * added by .github/workflows/mdbook.yml). RFC 9116 requires an Expires date less than
 * a year ahead; a stale file tells researchers the contact is dead. This test starts
 * failing 30 days before the date, so it is renewed in time: move Expires forward by
 * up to a year.
 */

import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(__dirname, '../../../docs/.well-known/security.txt');
const fields = Object.fromEntries(
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.includes(':'))
    .map(line => [
      line.slice(0, line.indexOf(':')).trim(),
      line.slice(line.indexOf(':') + 1).trim()
    ])
);

describe('docs/.well-known/security.txt', () => {
  test('names a contact and a policy', () => {
    expect(fields.Contact).toMatch(/^mailto:\S+@\S+$/);
    expect(fields.Policy).toMatch(/^https:\/\//);
  });

  test('expires more than 30 days and less than a year from now', () => {
    const expires = Date.parse(fields.Expires);
    const day = 24 * 60 * 60 * 1000;
    expect(Number.isNaN(expires)).toBe(false);
    expect(expires - Date.now()).toBeGreaterThan(30 * day);
    expect(expires - Date.now()).toBeLessThanOrEqual(366 * day);
  });
});
