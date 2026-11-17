// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The parameters the edit tools share (`edit_web_artifact`, `edit_docx`,
 * `edit_pptx`, `edit_xlsx`), as JSON Schema. Plain data, like the tool
 * definitions that use it; the checks live in `editableSource.js`.
 *
 * @module services/documents/editToolParameters
 */

/**
 * `filename`: the file of this chat to change.
 *
 * @param {string} example - A file name the tool makes, e.g. "report.docx".
 * @param {string} what - What the file is, e.g. "document".
 * @returns {Object}
 */
export function filenameParameter(example, what) {
  return {
    type: 'string',
    description: `The ${what} to change: its file name as created (e.g. "${example}") or its id.`
  };
}

/**
 * `edits`: exact text replacements, each `oldText` occurring once.
 *
 * @param {string} description - Where the replacements apply.
 * @returns {Object}
 */
export function textEditsParameter(description) {
  return {
    type: 'array',
    description,
    items: {
      type: 'object',
      properties: {
        oldText: { type: 'string', description: 'Text to replace, exactly as it is now.' },
        newText: {
          type: 'string',
          description: 'The replacement; an empty string deletes oldText.'
        }
      },
      required: ['oldText', 'newText']
    }
  };
}

/**
 * `set`: settings of the creating tool to change.
 *
 * @param {string} description - Which settings, with an example.
 * @returns {Object}
 */
export function settingsParameter(description) {
  return { type: 'object', description };
}
