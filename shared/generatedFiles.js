/**
 * Files a tool generated for the user (e.g. a PDF from the `pdf` system
 * skill), as the chat's download cards carry them.
 *
 * A file takes the path a generated picture takes:
 *
 * - **Live** — `{ id, name, mimeType, bytes, pages?, data }` on the
 *   `tool/completed` event, the bytes base64 in `data`.
 * - **Stored** — with the answer, as a `document` artifact of the chat
 *   (`message.artifacts`); {@link generatedFilesFromArtifacts} turns those
 *   into cards that fetch the bytes from the chat's (or the share's) artifact
 *   route by `id`. One the server declined to keep has `unavailable` instead.
 *
 * Shared by the server (which emits and stores them) and the client (which
 * renders the cards), so both accept exactly the same shape.
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
 * @returns {{ id?: string, name: string, mimeType: string, bytes: number, pages?: number,
 *   data?: string, stored?: true, unavailable?: string } | null}
 */
export function generatedFileOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (!GENERATED_FILE_MEDIA_TYPES.includes(entry.mimeType)) return null;
  const unavailable =
    typeof entry.unavailable === 'string' && entry.unavailable
      ? entry.unavailable.slice(0, 40)
      : null;
  const id = typeof entry.id === 'string' && FILE_ID.test(entry.id) ? entry.id : null;
  if (!id && !unavailable) return null;
  const name =
    typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 200) : 'file';
  const bytes = Number(entry.bytes);
  const pages = Number(entry.pages);
  return {
    ...(id ? { id } : {}),
    name,
    mimeType: entry.mimeType,
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
    ...(Number.isInteger(pages) && pages > 0 ? { pages } : {}),
    ...(typeof entry.data === 'string' && entry.data ? { data: entry.data } : {}),
    ...(entry.stored === true ? { stored: true } : {}),
    ...(unavailable ? { unavailable } : {})
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
    if (!file || (file.id && out.some(f => f.id === file.id))) continue;
    out.push(file);
    if (out.length >= MAX_GENERATED_FILES) break;
  }
  return out;
}

/**
 * The download cards of a stored message: its `document` artifacts of a
 * generated file type.
 *
 * @param {unknown} artifacts - `message.artifacts` as stored.
 * @returns {Array<Object>}
 */
export function generatedFilesFromArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return generatedFilesOf(
    artifacts
      .filter(artifact => artifact?.kind === 'document')
      .map(artifact => ({ ...artifact, data: undefined, stored: !artifact.unavailable }))
  );
}
