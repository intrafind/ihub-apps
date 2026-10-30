// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Font names for Word and PowerPoint files. PDFs embed their fonts; Office
 * files only name them, and the reader's computer draws them. The built-in
 * families PDFs use (`sans`, `serif`, `mono`) map to the Office fonts every
 * installation has; any other name — a brand font the company installs on
 * its computers — is kept as it is.
 */

const OFFICE_FONTS = { sans: 'Calibri', serif: 'Cambria', mono: 'Consolas' };

/**
 * The font name a Word or PowerPoint file names for a family.
 *
 * @param {unknown} family
 * @param {string} [fallback]
 * @returns {string|undefined}
 */
export function officeFontName(family, fallback) {
  if (typeof family !== 'string' || !family.trim()) return fallback;
  const name = family.trim();
  return OFFICE_FONTS[name.toLowerCase()] || name.slice(0, 64);
}
