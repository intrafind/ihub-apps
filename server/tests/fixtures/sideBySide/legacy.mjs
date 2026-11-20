// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A stand-in for a legacy workflow in `sideBySide.test.js`: it lists the input
 * files, numbering the rows from 0.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function run({ input, files }) {
  const rows = files.map((file, index) => ({
    row: index,
    file,
    bytes: fs.statSync(path.join(input, file)).size
  }));
  return {
    report: ['# Statements', '', ...rows.map(r => `${r.row}. ${r.file} (${r.bytes} bytes)`)].join(
      '\n'
    ),
    record: { steps: ['load', 'summarise'], rows, modelRequests: [{ roles: ['system', 'user'] }] }
  };
}
