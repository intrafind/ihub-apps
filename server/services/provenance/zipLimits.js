/**
 * Bounded reading of ZIP archives (DOCX, PPTX, XLSX) submitted for detection.
 *
 * The upload limit caps the compressed size only; a small archive can inflate
 * to gigabytes. Entries are checked against the sizes declared in the central
 * directory before anything is inflated, and the limits are enforced again
 * while inflating, so a lying central directory does not get past them.
 */

/** Limits for one archive. */
export const ZIP_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024
});

export class ZipLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipLimitError';
    this.status = 400;
  }
}

/**
 * The file entries of an archive, after checking the entry count and the
 * declared uncompressed sizes.
 * @param {import('jszip')} zip - a loaded archive (loading reads only the directory)
 * @param {typeof ZIP_LIMITS} [limits]
 * @returns {Array<import('jszip').JSZipObject>}
 */
export function zipEntries(zip, limits = ZIP_LIMITS) {
  const entries = Object.values(zip.files).filter(f => !f.dir);
  if (entries.length > limits.maxEntries) {
    throw new ZipLimitError(`The archive has more than ${limits.maxEntries} entries`);
  }
  let declared = 0;
  for (const entry of entries) {
    // JSZip keeps the central-directory size here; absent means unknown.
    const size = Number(entry._data?.uncompressedSize) || 0;
    if (size > limits.maxEntryBytes) {
      throw new ZipLimitError(`An archive entry is larger than ${limits.maxEntryBytes} bytes`);
    }
    declared += size;
  }
  if (declared > limits.maxTotalBytes) {
    throw new ZipLimitError(
      `The archive is larger than ${limits.maxTotalBytes} bytes uncompressed`
    );
  }
  return entries;
}

/**
 * A budget shared by the entries of one archive.
 * @param {typeof ZIP_LIMITS} [limits]
 */
export function inflateBudget(limits = ZIP_LIMITS) {
  return { remaining: limits.maxTotalBytes, limits };
}

/**
 * Inflate one entry, stopping as soon as it passes the per-entry limit or the
 * archive's remaining budget.
 * @param {import('jszip').JSZipObject} entry
 * @param {{remaining: number, limits: typeof ZIP_LIMITS}} budget
 * @param {BufferEncoding} [encoding] - return a string in this encoding
 * @returns {Promise<Buffer|string>}
 */
export function readZipEntry(entry, budget, encoding) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      budget.remaining -= chunk.length;
      if (size > budget.limits.maxEntryBytes || budget.remaining < 0) {
        done = true;
        stream.pause();
        stream.destroy?.();
        reject(new ZipLimitError('The archive inflates beyond the size limits'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', error => {
      if (done) return;
      done = true;
      reject(error);
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      const buffer = Buffer.concat(chunks, size);
      resolve(encoding ? buffer.toString(encoding) : buffer);
    });
  });
}
