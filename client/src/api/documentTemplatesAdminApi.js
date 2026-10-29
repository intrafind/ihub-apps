// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { makeAdminApiCall } from './adminApi.js';

/**
 * Admin API for document templates — the corporate design of generated PDF,
 * Word and PowerPoint files (`server/routes/admin/documentTemplates.js`).
 */

const BASE = '/admin/document-templates';

const enc = encodeURIComponent;

/** @returns {Promise<Array<Object>>} Every template, enabled or not. */
export async function fetchDocumentTemplates() {
  const response = await makeAdminApiCall(BASE);
  return Array.isArray(response.data?.templates) ? response.data.templates : [];
}

/**
 * One template, with what its Word and PowerPoint templates hold.
 *
 * @param {string} id
 * @returns {Promise<{ template: Object, files: Object }>}
 */
export async function fetchDocumentTemplate(id) {
  const response = await makeAdminApiCall(`${BASE}/${enc(id)}`);
  return response.data;
}

/**
 * @param {Object} template - With `id` and `name`.
 * @returns {Promise<{ template: Object }>}
 */
export async function createDocumentTemplate(template) {
  const response = await makeAdminApiCall(BASE, { method: 'POST', body: template });
  return response.data;
}

/**
 * @param {string} id
 * @param {Object} template
 * @returns {Promise<{ template: Object, files: Object }>}
 */
export async function saveDocumentTemplate(id, template) {
  const response = await makeAdminApiCall(`${BASE}/${enc(id)}`, { method: 'PUT', body: template });
  return response.data;
}

/** @param {string} id */
export async function deleteDocumentTemplate(id) {
  await makeAdminApiCall(`${BASE}/${enc(id)}`, { method: 'DELETE' });
}

/**
 * Upload a file into a template slot.
 *
 * @param {string} id
 * @param {string} slot - `logo`, `font`, `letterhead`, `letterheadFollowing`,
 *   `wordTemplate`, `powerpointTemplate`.
 * @param {File} file
 * @param {{ family?: string, face?: string }} [font] - Font slot only.
 * @returns {Promise<{ template: Object, file: string, info: Object, files: Object }>}
 */
export async function uploadDocumentTemplateFile(id, slot, file, font = {}) {
  const form = new FormData();
  if (font.family) form.append('family', font.family);
  if (font.face) form.append('face', font.face);
  form.append('file', file);
  const response = await makeAdminApiCall(`${BASE}/${enc(id)}/files/${enc(slot)}`, {
    method: 'POST',
    body: form
  });
  return response.data;
}

/**
 * Remove the file of a slot (a font family's style, or the whole family with
 * `face: 'normal'`).
 *
 * @returns {Promise<{ template: Object, files: Object }>}
 */
export async function removeDocumentTemplateFile(id, slot, font = {}) {
  const params = new URLSearchParams();
  if (font.family) params.set('family', font.family);
  if (font.face) params.set('face', font.face);
  const query = params.toString();
  const response = await makeAdminApiCall(
    `${BASE}/${enc(id)}/files/${enc(slot)}${query ? `?${query}` : ''}`,
    { method: 'DELETE' }
  );
  return response.data;
}

/**
 * The file of a slot as a blob (the logo preview).
 *
 * @returns {Promise<Blob>}
 */
export async function fetchDocumentTemplateFile(id, slot) {
  const response = await makeAdminApiCall(`${BASE}/${enc(id)}/files/${enc(slot)}`, {
    responseType: 'blob'
  });
  return response.data;
}

/**
 * A sample document rendered with the saved template.
 *
 * @param {string} id
 * @param {'pdf'|'png'|'docx'|'pptx'} format
 * @param {string} [language]
 * @returns {Promise<Blob>}
 */
export async function fetchDocumentTemplateSample(id, format, language) {
  const response = await makeAdminApiCall(`${BASE}/${enc(id)}/sample/${enc(format)}`, {
    method: 'POST',
    body: { language },
    responseType: 'blob'
  });
  return response.data;
}
