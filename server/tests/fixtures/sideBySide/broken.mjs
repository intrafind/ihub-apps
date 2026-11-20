// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** A side that cannot run, for `sideBySide.test.js`. */
export async function run() {
  throw new Error('the workflow is not installed');
}
