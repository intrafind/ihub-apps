/**
 * Admin API of the EU AI Act page (`/admin/eu-ai-act`, issue #2566).
 *
 * Thin wrappers around `makeAdminApiCall` for the conformance status, the
 * start-page banner and the records an admin makes on the page (dismissed
 * warnings, per-app disclosure opt-outs and exemptions, unmarked-model
 * acknowledgements). The server stamps every record (who, when, installation
 * URL/id, iHub version) and writes it to the audit log — the client only sends
 * the reason.
 *
 * Every function resolves with the response body (`response.data`) and rejects
 * with the axios error, so callers can use `getAdminApiErrorMessage(err)`.
 *
 * Server contract: `server/routes/admin/aiTransparency.js`.
 *
 * @module api/aiTransparencyAdminApi
 */
import { saveAs } from 'file-saver';
import { makeAdminApiCall } from './adminApi.js';

const BASE = '/admin/ai-transparency';

/** Fallback file name when the server sends no `Content-Disposition`. */
const DEFAULT_REPORT_FILENAME = 'eu-ai-act-compliance-report.pdf';

/**
 * Full conformance status: checklist, model matrix, apps, warnings, records,
 * signing and settings summary.
 *
 * @returns {Promise<Object>} The status object (see the API contract).
 */
export async function fetchAiTransparencyStatus() {
  const response = await makeAdminApiCall(`${BASE}/status`);
  return response.data;
}

/**
 * The start-page / admin-overview banner: undismissed warnings only.
 *
 * @returns {Promise<{conforming: boolean, featureActive: boolean, warnings: Array<{id: string, severity: 'error'|'warning', message: string, params: Object, dismissible: boolean}>, dismissedCount: number}>}
 */
export async function fetchComplianceBanner() {
  const response = await makeAdminApiCall(`${BASE}/banner`);
  return response.data;
}

/**
 * Dismiss a (dismissible) warning with a justification. The dismissal only
 * hides the banner entry for the current state; it never changes the
 * conformance status.
 *
 * @param {string} warningId - e.g. `model:gpt-4o:unmarked`
 * @param {string} reason - At least 10 characters.
 * @returns {Promise<{dismissal: Object}>}
 */
export async function dismissComplianceWarning(warningId, reason) {
  const response = await makeAdminApiCall(`${BASE}/dismissals`, {
    method: 'POST',
    body: { warningId, reason }
  });
  return response.data;
}

/**
 * Remove a dismissal so the warning shows in the banner again.
 *
 * @param {string} warningId
 * @returns {Promise<{success: boolean}>}
 */
export async function restoreComplianceWarning(warningId) {
  const response = await makeAdminApiCall(`${BASE}/dismissals/${encodeURIComponent(warningId)}`, {
    method: 'DELETE'
  });
  return response.data;
}

/**
 * Switch the Art. 50(1) interaction disclosure off for one app.
 *
 * @param {string} appId
 * @param {string} reason - At least 10 characters.
 * @returns {Promise<{disclosureOptOut: Object}>}
 */
export async function setAppDisclosureOptOut(appId, reason) {
  const response = await makeAdminApiCall(
    `${BASE}/apps/${encodeURIComponent(appId)}/disclosure-opt-out`,
    { method: 'PUT', body: { reason } }
  );
  return response.data;
}

/**
 * Switch the Art. 50(1) interaction disclosure back on for one app.
 *
 * @param {string} appId
 * @returns {Promise<{success: boolean}>}
 */
export async function clearAppDisclosureOptOut(appId) {
  const response = await makeAdminApiCall(
    `${BASE}/apps/${encodeURIComponent(appId)}/disclosure-opt-out`,
    { method: 'DELETE' }
  );
  return response.data;
}

/**
 * Declare an Art. 50(2) exemption for one app.
 *
 * @param {string} appId
 * @param {'standardEditing'|'b2bTechnical'} type
 * @param {string} justification - At least 10 characters.
 * @returns {Promise<{exemption: Object}>}
 */
export async function declareAppExemption(appId, type, justification) {
  const response = await makeAdminApiCall(`${BASE}/apps/${encodeURIComponent(appId)}/exemption`, {
    method: 'PUT',
    body: { type, justification }
  });
  return response.data;
}

/**
 * Withdraw the Art. 50(2) exemption of one app.
 *
 * @param {string} appId
 * @returns {Promise<{success: boolean}>}
 */
export async function withdrawAppExemption(appId) {
  const response = await makeAdminApiCall(`${BASE}/apps/${encodeURIComponent(appId)}/exemption`, {
    method: 'DELETE'
  });
  return response.data;
}

/**
 * Acknowledge that a model's output is not marked. Documents the known gap;
 * the model stays non-conforming.
 *
 * @param {string} modelId
 * @param {string} justification - At least 10 characters.
 * @returns {Promise<{acknowledgement: Object}>}
 */
export async function acknowledgeUnmarkedModel(modelId, justification) {
  const response = await makeAdminApiCall(
    `${BASE}/models/${encodeURIComponent(modelId)}/acknowledgement`,
    { method: 'PUT', body: { justification } }
  );
  return response.data;
}

/**
 * Withdraw an unmarked-model acknowledgement.
 *
 * @param {string} modelId
 * @returns {Promise<{success: boolean}>}
 */
export async function withdrawModelAcknowledgement(modelId) {
  const response = await makeAdminApiCall(
    `${BASE}/models/${encodeURIComponent(modelId)}/acknowledgement`,
    { method: 'DELETE' }
  );
  return response.data;
}

/**
 * Read the server's `{ error }` message out of a failed blob request. With
 * `responseType: 'blob'` axios hands the JSON error body over as a Blob, so
 * `getAdminApiErrorMessage` cannot see it.
 *
 * @param {Error & {response?: {data?: Blob}}} error
 * @returns {Promise<string|null>} The server message, or null if there is none.
 */
async function readBlobErrorMessage(error) {
  const data = error?.response?.data;
  if (!data || typeof data.text !== 'function') return null;
  try {
    const parsed = JSON.parse(await data.text());
    return parsed?.error || parsed?.message || null;
  } catch {
    return null;
  }
}

/**
 * Extract the file name from a `Content-Disposition` header.
 *
 * @param {string|undefined} header
 * @returns {string|null}
 */
function filenameFromDisposition(header) {
  const match = typeof header === 'string' ? header.match(/filename="?([^";]+)"?/i) : null;
  return match ? match[1] : null;
}

/**
 * Download the signed compliance report (PDF) and save it through the
 * browser. Uses the authenticated admin call so it also works cross-origin
 * (Vite dev server) and in anonymous mode with an admin token.
 *
 * @returns {Promise<string>} The file name the report was saved as.
 * @throws {Error} With the server's error message when the report fails.
 */
export async function downloadComplianceReport() {
  let response;
  try {
    response = await makeAdminApiCall(`${BASE}/report.pdf`, { responseType: 'blob' });
  } catch (error) {
    const serverMessage = await readBlobErrorMessage(error);
    if (serverMessage) error.message = serverMessage;
    throw error;
  }
  const filename =
    filenameFromDisposition(response.headers?.['content-disposition']) || DEFAULT_REPORT_FILENAME;
  const blob =
    response.data instanceof Blob
      ? response.data
      : new Blob([response.data], { type: 'application/pdf' });
  saveAs(blob, filename);
  return filename;
}
