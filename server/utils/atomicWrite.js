import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file using a temporary file and rename
 * This prevents data corruption from partial writes
 *
 * @param {string} filePath - The target file path
 * @param {string} data - The data to write
 * @param {string} encoding - File encoding (default: 'utf8')
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, data, encoding = 'utf8') {
  const dir = dirname(filePath);
  const tempSuffix = randomBytes(8).toString('hex');
  const tempPath = join(dir, `.tmp_${tempSuffix}`);

  try {
    // Write to temporary file first
    await fs.writeFile(tempPath, data, encoding);

    // Atomically rename temp file to target file
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Atomically write JSON data to a file with pretty formatting
 *
 * @param {string} filePath - The target file path
 * @param {any} data - The data to serialize as JSON
 * @returns {Promise<void>}
 */
export async function atomicWriteJSON(filePath, data) {
  const jsonData = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, jsonData, 'utf8');
}
