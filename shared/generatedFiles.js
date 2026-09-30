/**
 * Files a tool generated for the user (e.g. a PDF from the `pdf` system
 * skill), as descriptors the chat carries: on the `tool/completed` event, on
 * the finished message, and in the stored transcript.
 *
 * Shared by the server (which emits and stores them) and the client (which
 * renders the download cards), so both accept exactly the same shape. The
 * bytes are fetched from `GET /api/generated-files/:id`, which only serves the
 * file to the user it was generated for.
 */

/** Most generated files one message keeps. */
export const MAX_GENERATED_FILES = 20;

/** Media types a generated file may have. */
export const GENERATED_FILE_MEDIA_TYPES = Object.freeze(['application/pdf']);

const FILE_ID = /^[a-f0-9]{32}$/;

/**
 * Normalize one descriptor, or return null when it is not one.
 *
 * @param {unknown} entry
 * @returns {{ id: string, name: string, mimeType: string, bytes: number, pages?: number, createdAt?: string } | null}
 */
export function generatedFileOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.id !== 'string' || !FILE_ID.test(entry.id)) return null;
  if (!GENERATED_FILE_MEDIA_TYPES.includes(entry.mimeType)) return null;
  const name =
    typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 200) : 'file';
  const bytes = Number(entry.bytes);
  const pages = Number(entry.pages);
  return {
    id: entry.id,
    name,
    mimeType: entry.mimeType,
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
    ...(Number.isInteger(pages) && pages > 0 ? { pages } : {}),
    ...(typeof entry.createdAt === 'string' ? { createdAt: entry.createdAt.slice(0, 40) } : {})
  };
}

/**
 * Normalize a list of descriptors: valid ones only, no duplicates, bounded.
 *
 * @param {unknown} list
 * @returns {Array<Object>}
 */
export function generatedFilesOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const file = generatedFileOf(entry);
    if (!file || out.some(f => f.id === file.id)) continue;
    out.push(file);
    if (out.length >= MAX_GENERATED_FILES) break;
  }
  return out;
}
