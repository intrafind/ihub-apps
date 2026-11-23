// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Texts as a reader sees them: without the characters a person cannot see but
 * a model reads.
 *
 * Used wherever a text reaches a model and a person is meant to have read it
 * first: the content of a personal app (`server/validators/userAppSchema.js`),
 * a generated draft (`server/services/appGenerator.js`) and a revision of an
 * app (`server/services/appRevision.js`). Isomorphic: no Node import, so the
 * client can use it too.
 *
 * @module shared/visibleText
 */

/**
 * Characters a reader cannot see: control characters (category Cc) other
 * than newline and tab, format characters (category Cf: zero-width and
 * bidirectional marks, the soft hyphen), every default-ignorable code point
 * (variation selectors, the combining grapheme joiner, the Hangul fillers),
 * the tag block U+E0000 to U+E007F, private-use characters (Co), the line
 * and paragraph separators U+2028 and U+2029, and the Braille blank U+2800.
 * A variation selector can carry one byte each, so a payload in them would
 * hide behind a harmless sentence.
 */
const HIDDEN_CHARACTERS =
  /(?![\n\t])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Zl}\p{Zp}\u2800\u{E0000}-\u{E007F}]/gu;

/**
 * A text without the characters a reader cannot see. A value that is not a
 * string is returned as it is.
 *
 * @param {string} text
 * @returns {string}
 *
 * @example
 * stripHiddenCharacters('Be\u200B brief\u202E.'); // → 'Be brief.'
 */
export function stripHiddenCharacters(text) {
  return typeof text === 'string' ? text.replace(HIDDEN_CHARACTERS, '') : text;
}
