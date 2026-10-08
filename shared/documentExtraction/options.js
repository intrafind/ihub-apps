/**
 * The per-app options of document extraction (`upload.fileUpload` of an app). All of them send
 * more than the visible text of a document and are therefore off unless an app asks for them
 * (decision A3):
 *
 *   - `trackedChanges: 'markup'` — Word: insertions and deletions as `{++added++}` / `{--removed--}`
 *   - `comments: 'inline'`       — Word: comments as `{>>Author: text<<}`
 *   - `speakerNotes: 'include'`  — PowerPoint: the notes of a slide as `[Notes]`
 *
 * @module shared/documentExtraction/options
 */
import { normalizeReviewOptions } from './ooxml/review.js';

/**
 * Anything that is not an option value — a missing block, an unknown value — means the default.
 *
 * @param {{trackedChanges?: string, comments?: string, speakerNotes?: string}} [options]
 * @returns {{trackedChanges: 'accepted'|'markup', comments: 'ignore'|'inline', speakerNotes: 'ignore'|'include'}}
 */
export function normalizeExtractionOptions(options) {
  return {
    ...normalizeReviewOptions(options),
    speakerNotes: options?.speakerNotes === 'include' ? 'include' : 'ignore'
  };
}
