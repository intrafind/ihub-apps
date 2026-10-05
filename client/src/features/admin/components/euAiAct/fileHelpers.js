/**
 * Browser helpers shared by the EU AI Act admin tabs (Settings, Certificates,
 * Detection): saving files, reading uploads, copying to the clipboard,
 * formatting values and turning failed API calls into displayable errors.
 *
 * Everything here is UI-framework agnostic so it can be unit tested without
 * rendering a component.
 *
 * @module features/admin/components/euAiAct/fileHelpers
 */

/**
 * Save a string as a file download in the browser.
 *
 * @param {string} filename - Name offered in the save dialog, e.g. `ihub-trust-anchor.pem`
 * @param {string} content - File content
 * @param {string} [mimeType='text/plain'] - MIME type of the blob
 * @example
 * downloadTextFile('request.csr', csrPem, 'application/pkcs10');
 */
export function downloadTextFile(filename, content, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Save a value as a pretty-printed JSON file download.
 *
 * @param {string} filename - Name offered in the save dialog
 * @param {unknown} data - JSON-serialisable value
 */
export function downloadJsonFile(filename, data) {
  downloadTextFile(filename, `${JSON.stringify(data, null, 2)}\n`, 'application/json');
}

/**
 * Read a user-selected file as text (PEM files, JSON bundles).
 *
 * @param {File} file - File from an `<input type="file">`
 * @returns {Promise<string>} The file content decoded as UTF-8
 */
export function readFileAsText(file) {
  if (typeof file?.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('File could not be read'));
    reader.readAsText(file);
  });
}

/**
 * Read a user-selected binary file (e.g. PKCS#12) as base64, without the
 * `data:<mime>;base64,` prefix a data URL carries.
 *
 * @param {File} file - File from an `<input type="file">`
 * @returns {Promise<string>} Base64-encoded file content
 */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('File could not be read'));
    reader.readAsDataURL(file);
  });
}

/**
 * Copy text to the clipboard, with a fallback for browsers or contexts
 * (plain HTTP) where the async Clipboard API is not available.
 *
 * @param {string} text - Text to copy
 * @returns {Promise<void>} Rejects when copying is not possible
 */
export async function copyText(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copy to clipboard is not available');
}

/**
 * Format an ISO timestamp for display in the admin UI.
 *
 * @param {string|number|Date|null|undefined} value - Timestamp
 * @param {string} [locale] - BCP 47 locale, usually `i18n.language`
 * @param {Intl.DateTimeFormatOptions} [options] - Overrides of the default format
 * @returns {string} The formatted date, or an em dash for empty/invalid input
 */
export function formatDateTime(value, locale, options) {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleString(locale, options || { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toISOString();
  }
}

/**
 * Format a date without time (certificate validity).
 *
 * @param {string|number|Date|null|undefined} value - Timestamp
 * @param {string} [locale] - BCP 47 locale
 * @returns {string}
 */
export function formatDate(value, locale) {
  return formatDateTime(value, locale, { dateStyle: 'medium' });
}

/**
 * Format a byte count as a short human-readable size (B, KB, MB, GB).
 *
 * @param {number|null|undefined} bytes - Size in bytes
 * @param {string} [locale] - BCP 47 locale for the number
 * @returns {string} e.g. `1.4 MB`, or an em dash when unknown
 */
export function formatBytes(bytes, locale) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}

/**
 * Format a ratio between 0 and 1 as a percentage (TPR/FPR in the benchmark).
 *
 * @param {number|null|undefined} ratio - Value between 0 and 1
 * @param {string} [locale] - BCP 47 locale
 * @returns {string} e.g. `97.5 %`, or an em dash when unknown
 */
export function formatPercent(ratio, locale) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—';
  try {
    return ratio.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 1 });
  } catch {
    return `${Math.round(ratio * 1000) / 10} %`;
  }
}

/**
 * Turn a failed axios call into `{ status, message, details }`.
 *
 * Handles JSON error bodies (`{ error, details }` from the admin API) and
 * string bodies (responses requested with `responseType: 'text'`, where the
 * JSON arrives unparsed).
 *
 * @param {unknown} err - Error thrown by axios / makeAdminApiCall
 * @returns {{ status: number|null, message: string, details: string[] }}
 */
export function extractApiError(err) {
  const response = err?.response;
  let data = response?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = { error: data.trim() ? data.trim().slice(0, 500) : undefined };
    }
  }
  const details = Array.isArray(data?.details)
    ? data.details.map(d => (typeof d === 'string' ? d : JSON.stringify(d))).filter(Boolean)
    : [];
  return {
    status: typeof response?.status === 'number' ? response.status : null,
    message: data?.error || data?.message || err?.message || '',
    details
  };
}

/**
 * A filesystem-safe timestamp for file names: `2026-09-29T12-30-00`.
 *
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function fileTimestamp(date = new Date()) {
  return date.toISOString().replace(/\..+$/, '').replace(/:/g, '-');
}
