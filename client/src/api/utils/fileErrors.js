// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether a failed file request means "the original is gone, the text is not".
 *
 * A blob response body is a `Blob`, so the code is read from the response data
 * when it is JSON-shaped, and from the status otherwise.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isOriginalDiscarded(error) {
  const status = error?.status ?? error?.response?.status;
  if (status === 410) return true;
  const data = error?.response?.data;
  return data?.details?.code === 'ORIGINAL_DISCARDED' || data?.code === 'ORIGINAL_DISCARDED';
}
