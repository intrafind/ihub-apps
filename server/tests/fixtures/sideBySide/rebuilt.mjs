// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A stand-in for a rebuilt workflow in `sideBySide.test.js`: the same list as
 * `legacy.mjs`, with rows numbered from 1 and one more step.
 */
import fs from 'node:fs';
import path from 'node:path';

export default async function rebuilt({ input, files }) {
  const rows = files.map((file, index) => ({
    row: index + 1,
    file,
    bytes: fs.statSync(path.join(input, file)).size
  }));
  return {
    report: ['# Statements', '', ...rows.map(r => `${r.row}. ${r.file} (${r.bytes} bytes)`)].join(
      '\n'
    ),
    record: {
      steps: ['load', 'check', 'summarise'],
      rows,
      modelRequests: [{ roles: ['system', 'user'] }]
    }
  };
}
