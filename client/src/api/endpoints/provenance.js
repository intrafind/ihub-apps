/**
 * Public detection API (EU AI Act Art. 50(2); issue #2573) used by the
 * `/verify` page. None of these calls needs a session when the admin set the
 * detector access to `public`; `authentication-required` and `forbidden`
 * installations answer `GET /provenance/info` with `canVerify: false`.
 *
 * Contract: `server/routes/provenance.js`.
 *
 * @module api/endpoints/provenance
 */
import { apiClient } from '../client';

/** Detection of a large image or document can take a while (TrustMark decode). */
export const VERIFY_REQUEST_TIMEOUT = 120000;

/**
 * A detection request the server refused or that never reached it.
 * `status` is the HTTP status (401, 403, 404, 413, 429, …) or `null`.
 */
export class ProvenanceRequestError extends Error {
  /**
   * @param {string} message - Server error text (English) or transport message
   * @param {number|null} [status] - HTTP status, null when there was none
   * @param {unknown} [cause]
   */
  constructor(message, status, cause) {
    super(message);
    this.name = 'ProvenanceRequestError';
    this.status = status ?? null;
    if (cause !== undefined) this.cause = cause;
  }
}

function toProvenanceError(error) {
  const status = error?.response?.status ?? null;
  const message = error?.response?.data?.error || error?.message || 'Request failed';
  return new ProvenanceRequestError(String(message), status, error);
}

// A 401 here is an answer ("sign in to use the detector"), not an expired
// session: the page shows its own sign-in hint instead of the global overlay.
const PUBLIC_REQUEST = { _suppressAuthExpired: true };

/**
 * What the caller may do with the detector.
 *
 * @returns {Promise<{enabled: boolean, access: 'internal'|'authenticated'|'public',
 *   canVerify: boolean, reason: (null|'disabled'|'authentication-required'|'forbidden'),
 *   canUseTextDetection: boolean, maxUploadMB: number, techniques: string[]}>}
 * @throws {ProvenanceRequestError}
 */
export async function fetchProvenanceInfo() {
  try {
    const response = await apiClient.get('/provenance/info', PUBLIC_REQUEST);
    return response.data;
  } catch (error) {
    throw toProvenanceError(error);
  }
}

/**
 * Check a file or a text for AI markings.
 *
 * @param {Object} input - Exactly one of `file` or `text`
 * @param {File|Blob} [input.file] - Uploaded as multipart field `file`
 * @param {string} [input.text] - Sent as JSON `{ text }`
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{result: Object, report: (string|null), reportPayload: Object}>}
 *   `result` = `{ verdict, aiGenerated, techniques, content, provenance, detector, checkedAt, summary }`
 * @throws {ProvenanceRequestError}
 */
export async function verifyProvenanceContent({ file, text } = {}, { signal } = {}) {
  const config = { ...PUBLIC_REQUEST, timeout: VERIFY_REQUEST_TIMEOUT, signal };
  const body = file ? new FormData() : { text: String(text ?? '') };
  if (file) {
    body.append('file', file, file.name || 'upload');
    // The shared instance defaults to a JSON content type, which would make
    // axios serialise the form to JSON; undefined lets the browser set the
    // multipart boundary (same fix as `makeAdminApiCall`).
    config.headers = { 'Content-Type': undefined };
  }
  try {
    const response = await apiClient.post('/provenance/verify', body, config);
    return response.data;
  } catch (error) {
    throw toProvenanceError(error);
  }
}

/**
 * Check a signed detection report (compact JWS).
 *
 * @param {string} report - The `report` value of a downloaded verification report
 * @returns {Promise<{valid: boolean, trusted: boolean, payload: (Object|null),
 *   signer: (Object|null), errors: string[]}>}
 * @throws {ProvenanceRequestError}
 */
export async function verifySignedReport(report) {
  try {
    const response = await apiClient.post('/provenance/report/verify', { report }, PUBLIC_REQUEST);
    return response.data;
  } catch (error) {
    throw toProvenanceError(error);
  }
}
