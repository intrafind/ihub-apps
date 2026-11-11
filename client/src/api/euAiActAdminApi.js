// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { makeAdminApiCall } from './adminApi';

/**
 * Calls of the EU AI Act overview page. Thin wrappers over `makeAdminApiCall`;
 * the key and detector endpoints belong to the text watermark feature, the
 * verification endpoint to provenance.
 */

/** The configuration check (`refresh` probes the detectors again). */
export async function fetchEuAiActStatus({ refresh = false } = {}) {
  const response = await makeAdminApiCall(
    `/admin/eu-ai-act/status${refresh ? '?refresh=true' : ''}`
  );
  return response.data;
}

/** @returns {Promise<{items: Object[]}>} Keys without key material. */
export async function fetchWatermarkKeys() {
  const response = await makeAdminApiCall('/admin/watermark-keys');
  return response.data;
}

/** Generate a key (no `key`) or add an own one; the answer carries the key once. */
export async function createWatermarkKey({ key, label } = {}) {
  const body = {};
  if (key) body.key = key;
  if (label) body.label = label;
  const response = await makeAdminApiCall('/admin/watermark-keys', { method: 'POST', body });
  return response.data;
}

/** Show a stored key (audited by the server). */
export async function revealWatermarkKey(keyId) {
  const response = await makeAdminApiCall(
    `/admin/watermark-keys/${encodeURIComponent(keyId)}/_reveal`,
    { method: 'POST' }
  );
  return response.data;
}

/**
 * Make a retired key the active one (rollback). The answer is the item, never the
 * key value. Already active answers 200 too (nothing changes); unknown is 404.
 */
export async function activateWatermarkKey(keyId) {
  const response = await makeAdminApiCall(
    `/admin/watermark-keys/${encodeURIComponent(keyId)}/_activate`,
    { method: 'POST' }
  );
  return response.data;
}

export async function deleteWatermarkKey(keyId) {
  await makeAdminApiCall(`/admin/watermark-keys/${encodeURIComponent(keyId)}`, {
    method: 'DELETE'
  });
}

/** @returns {Promise<{items: Object[]}>} Static detector settings per "ihub" model. */
export async function fetchWatermarkDetectors() {
  const response = await makeAdminApiCall('/admin/watermark-detectors');
  return response.data;
}

export async function testWatermarkDetector(modelId) {
  const response = await makeAdminApiCall(
    `/admin/watermark-detectors/${encodeURIComponent(modelId)}/_test`,
    { method: 'POST' }
  );
  return response.data;
}

/** One real generation: costs about 400 tokens. */
export async function runWatermarkSelfTest(modelId) {
  const response = await makeAdminApiCall(
    `/admin/watermark-detectors/${encodeURIComponent(modelId)}/_self-test`,
    { method: 'POST' }
  );
  return response.data;
}

/** Look up a text (`{text}`) or hash (`{contentHash}`). */
export async function verifyText(text) {
  const response = await makeAdminApiCall('/provenance/_verify', {
    method: 'POST',
    body: { text }
  });
  return response.data;
}

/** Look up an image or audio file (multipart). */
export async function verifyFile(file, kind) {
  const form = new FormData();
  if (kind) form.append('kind', kind);
  form.append('file', file);
  const response = await makeAdminApiCall('/provenance/_verify', { method: 'POST', body: form });
  return response.data;
}
