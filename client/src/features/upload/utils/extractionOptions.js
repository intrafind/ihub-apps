import { normalizeExtractionOptions } from '../../../../../shared/documentExtraction/options.js';

/**
 * The extraction options of an app's `upload.fileUpload` block: Word review marks (tracked
 * changes as CriticMarkup, comments inline) and PowerPoint speaker notes, all off unless the app
 * opts in. Anything else — a missing block, an unknown value — means the default.
 *
 * Kept apart from fileProcessing (which pulls in the heavy document libraries) so that callers
 * that only translate app settings into options stay light.
 *
 * @param {{trackedChanges?: string, comments?: string, speakerNotes?: string}} [fileUploadConfig]
 * @returns {{trackedChanges: 'accepted'|'markup', comments: 'ignore'|'inline', speakerNotes: 'ignore'|'include'}}
 */
export const extractionOptionsOf = fileUploadConfig => normalizeExtractionOptions(fileUploadConfig);
