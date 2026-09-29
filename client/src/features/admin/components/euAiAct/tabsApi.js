/**
 * API calls used by the EU AI Act admin tabs (Settings, Certificates,
 * Detection). Admin endpoints go through `makeAdminApiCall` (which prefixes
 * `/api` and adds the admin auth header); the detector itself
 * (`POST /api/provenance/verify`) is a regular user endpoint and goes through
 * the shared `apiClient`.
 *
 * Every function resolves to the response body (`response.data`) and rejects
 * with the axios error, so callers can use `extractApiError` from
 * `fileHelpers.js` to show `error` and `details`.
 *
 * Contract: `concepts/2026-09-27 EU AI Act Content Marking.md` §8.4–§8.6 and
 * `server/routes/admin/aiTransparency.js`.
 *
 * @module features/admin/components/euAiAct/tabsApi
 */
import { makeAdminApiCall } from '../../../../api/adminApi';
import { apiClient } from '../../../../api/client';

const BASE = '/admin/ai-transparency';

/** Long-running calls (benchmark, uploads) must not hit the 30 s client default. */
const LONG_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

const id = value => encodeURIComponent(String(value));

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * Load the resolved `platform.aiTransparency` section.
 * @returns {Promise<{ settings: Object, installation: { installationId: string, installationUrl: string, ihubVersion: string } }>}
 */
export async function fetchTransparencySettings() {
  const response = await makeAdminApiCall(`${BASE}/settings`);
  return response.data;
}

/**
 * Save changed top-level sections of `platform.aiTransparency`.
 * The server deep-merges each section; `detection.experts` and
 * `detection.zeroRetention` are ignored there.
 *
 * @param {Object} patch - Only the changed top-level keys
 * @returns {Promise<{ settings: Object, changed: string[] }>}
 */
export async function saveTransparencySettings(patch) {
  const response = await makeAdminApiCall(`${BASE}/settings`, { method: 'PUT', body: patch });
  return response.data;
}

// ── Certificates ────────────────────────────────────────────────────────────

/**
 * Signing status: library availability, time-stamping, active certificate
 * and every stored certificate (never key material).
 * @returns {Promise<Object>}
 */
export async function fetchCertificates() {
  const response = await makeAdminApiCall(`${BASE}/certificates`);
  return response.data;
}

/**
 * Download the installation's published trust anchor as PEM text.
 * @returns {Promise<string>}
 */
export async function fetchTrustAnchorPem() {
  const response = await makeAdminApiCall(`${BASE}/certificates/trust-anchor.pem`, {
    responseType: 'text'
  });
  return typeof response.data === 'string' ? response.data : String(response.data ?? '');
}

/**
 * Issue a new auto-generated installation certificate; the previous one
 * becomes detect-only.
 * @returns {Promise<{ certificate: Object, test: Object }>}
 */
export async function rotateCertificate() {
  const response = await makeAdminApiCall(`${BASE}/certificates/rotate`, {
    method: 'POST',
    body: {}
  });
  return response.data;
}

/**
 * Install a custom certificate from PEM (`chainPem` + `keyPem`) or PKCS#12
 * (`pkcs12Base64` + `password`).
 * @param {{ chainPem?: string, keyPem?: string, pkcs12Base64?: string, password?: string }} body
 * @returns {Promise<{ certificate: Object, test: Object, warnings: string[] }>}
 */
export async function installCustomCertificate(body) {
  const response = await makeAdminApiCall(`${BASE}/certificates/custom`, {
    method: 'POST',
    body,
    timeout: UPLOAD_TIMEOUT_MS
  });
  return response.data;
}

/**
 * Generate a key pair and a CSR on the server (the key never leaves it).
 * @param {{ commonName?: string, organization?: string, email?: string }} subject
 * @returns {Promise<{ certificate: Object }>} The pending entry with `csrPem`
 */
export async function createCertificateRequest(subject) {
  const response = await makeAdminApiCall(`${BASE}/certificates/csr`, {
    method: 'POST',
    body: subject
  });
  return response.data;
}

/**
 * Install the certificate a CA issued for a pending CSR.
 * @param {string} certificateId
 * @param {string} chainPem - Issued certificate, with its chain
 * @returns {Promise<{ certificate: Object, test: Object, warnings: string[] }>}
 */
export async function completeCertificateRequest(certificateId, chainPem) {
  const response = await makeAdminApiCall(`${BASE}/certificates/${id(certificateId)}/complete`, {
    method: 'POST',
    body: { chainPem },
    timeout: UPLOAD_TIMEOUT_MS
  });
  return response.data;
}

/**
 * Switch back to a detect-only certificate (rollback).
 * @param {string} certificateId
 * @returns {Promise<{ certificate: Object }>}
 */
export async function activateCertificate(certificateId) {
  const response = await makeAdminApiCall(`${BASE}/certificates/${id(certificateId)}/activate`, {
    method: 'POST',
    body: {}
  });
  return response.data;
}

/**
 * Remove a pending certificate request.
 * @param {string} certificateId
 * @returns {Promise<{ success: boolean }>}
 */
export async function removeCertificateRequest(certificateId) {
  const response = await makeAdminApiCall(`${BASE}/certificates/${id(certificateId)}`, {
    method: 'DELETE'
  });
  return response.data;
}

// ── Text watermark key groups ───────────────────────────────────────────────

/** @returns {Promise<{ keyGroups: Object[] }>} */
export async function fetchKeyGroups() {
  const response = await makeAdminApiCall(`${BASE}/key-groups`);
  return response.data;
}

/**
 * @param {{ id: string, name?: string, detectorUrl?: string, contextWidth?: number }} body
 * @returns {Promise<{ keyGroup: Object }>}
 */
export async function createKeyGroup(body) {
  const response = await makeAdminApiCall(`${BASE}/key-groups`, { method: 'POST', body });
  return response.data;
}

/**
 * @param {string} groupId
 * @param {{ name?: string, detectorUrl?: string, contextWidth?: number }} body
 * @returns {Promise<{ keyGroup: Object }>}
 */
export async function updateKeyGroup(groupId, body) {
  const response = await makeAdminApiCall(`${BASE}/key-groups/${id(groupId)}`, {
    method: 'PUT',
    body
  });
  return response.data;
}

/**
 * Create a new key version; older versions stay detect-only.
 * @param {string} groupId
 * @returns {Promise<{ keyGroup: Object }>}
 */
export async function rotateKeyGroup(groupId) {
  const response = await makeAdminApiCall(`${BASE}/key-groups/${id(groupId)}/rotate`, {
    method: 'POST',
    body: {}
  });
  return response.data;
}

/**
 * @param {string} groupId
 * @returns {Promise<{ success: boolean }>}
 */
export async function deleteKeyGroup(groupId) {
  const response = await makeAdminApiCall(`${BASE}/key-groups/${id(groupId)}`, {
    method: 'DELETE'
  });
  return response.data;
}

/**
 * Reveal the active key as vLLM `--watermark-config` JSON. Audited on the server.
 * @param {string} groupId
 * @returns {Promise<{ version: number, watermarkConfig: string }>}
 */
export async function revealVllmConfig(groupId) {
  const response = await makeAdminApiCall(`${BASE}/key-groups/${id(groupId)}/vllm-config`, {
    method: 'POST',
    body: {}
  });
  return response.data;
}

/**
 * Export key groups as an encrypted bundle.
 * @param {string[]} ids
 * @param {string} passphrase - At least 12 characters
 * @returns {Promise<Object>} The bundle JSON
 */
export async function exportKeyBundle(ids, passphrase) {
  const response = await makeAdminApiCall(`${BASE}/key-groups/export`, {
    method: 'POST',
    body: { ids, passphrase }
  });
  return response.data;
}

/**
 * Import an encrypted key bundle.
 * @param {Object} bundle - Parsed bundle JSON
 * @param {string} passphrase
 * @returns {Promise<{ keyGroups: Object[] }>}
 */
export async function importKeyBundle(bundle, passphrase) {
  const response = await makeAdminApiCall(`${BASE}/key-groups/import`, {
    method: 'POST',
    body: { bundle, passphrase }
  });
  return response.data;
}

// ── Detection administration ────────────────────────────────────────────────

/**
 * Detection log (metadata only, newest first).
 * @param {number} [limit=100]
 * @returns {Promise<{ entries: Object[] }>}
 */
export async function fetchDetectionLog(limit = 100) {
  const response = await makeAdminApiCall(`${BASE}/detection/log?limit=${Number(limit) || 100}`);
  return response.data;
}

/**
 * Approve a user for free-form text watermark detection (CoP 2.1.2).
 * @param {{ userId: string, name?: string, reason: string }} body
 * @returns {Promise<{ expert: Object }>}
 */
export async function approveExpert(body) {
  const response = await makeAdminApiCall(`${BASE}/detection/experts`, { method: 'POST', body });
  return response.data;
}

/**
 * @param {string} userId
 * @returns {Promise<{ success: boolean }>}
 */
export async function revokeExpert(userId) {
  const response = await makeAdminApiCall(`${BASE}/detection/experts/${id(userId)}`, {
    method: 'DELETE'
  });
  return response.data;
}

/** @returns {Promise<{ report: Object|null }>} Latest robustness benchmark report */
export async function fetchBenchmark() {
  const response = await makeAdminApiCall(`${BASE}/benchmark`);
  return response.data;
}

/**
 * Run the self-test (`quick: true`) or the full benchmark (may take minutes).
 * @param {boolean} quick
 * @returns {Promise<{ report: Object }>}
 */
export async function runBenchmark(quick) {
  const response = await makeAdminApiCall(`${BASE}/benchmark`, {
    method: 'POST',
    body: { quick: Boolean(quick) },
    timeout: LONG_REQUEST_TIMEOUT_MS
  });
  return response.data;
}

// ── Detector (user endpoint, not under /admin) ──────────────────────────────

/**
 * Check a file or a pasted text for AI markings.
 *
 * @param {{ file?: File, text?: string }} input - Exactly one of `file` or `text`
 * @returns {Promise<{ result: Object, report: string|null, reportPayload: Object|null }>}
 */
export async function verifyContent({ file, text }) {
  if (file) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post('/provenance/verify', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: UPLOAD_TIMEOUT_MS
    });
    return response.data;
  }
  const response = await apiClient.post(
    '/provenance/verify',
    { text: text ?? '' },
    { timeout: UPLOAD_TIMEOUT_MS }
  );
  return response.data;
}
