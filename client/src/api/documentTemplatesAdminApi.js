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
  return Array.isArray(response.data?.items) ? response.data.items : [];
}

/**
 * One template, with what its Word and PowerPoint templates hold and what it
 * resolves to (`resolved`: the brand and the PDF margins, with their sources).
 *
 * @param {string} id
 * @returns {Promise<{ template: Object, files: Object, resolved: Object }>}
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
 * @returns {Promise<{ template: Object, files: Object, resolved: Object }>}
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
 * @param {'wordTemplate'|'powerpointTemplate'} slot
 * @param {File} file
 * @returns {Promise<{ template: Object, file: string, info: Object, files: Object, resolved: Object }>}
 */
export async function uploadDocumentTemplateFile(id, slot, file) {
  const form = new FormData();
  form.append('file', file);
  const response = await makeAdminApiCall(`${BASE}/${enc(id)}/files/${enc(slot)}`, {
    method: 'POST',
    body: form
  });
  return response.data;
}

/**
 * Remove the file of a slot.
 *
 * @param {string} id
 * @param {'wordTemplate'|'powerpointTemplate'} slot
 * @returns {Promise<{ template: Object, files: Object, resolved: Object }>}
 */
export async function removeDocumentTemplateFile(id, slot) {
  const response = await makeAdminApiCall(`${BASE}/${enc(id)}/files/${enc(slot)}`, {
    method: 'DELETE'
  });
  return response.data;
}

/**
 * The colours and fonts of the theme of a template's Word or PowerPoint file,
 * for "Take colours from this file". Nothing is saved.
 *
 * @param {string} id
 * @param {'wordTemplate'|'powerpointTemplate'} slot
 * @returns {Promise<{ primaryColor?: string, accentColor?: string, textColor?: string,
 *   palette?: string[], headingFont?: string, bodyFont?: string }>}
 */
export async function readDocumentTemplateBrand(id, slot) {
  const response = await makeAdminApiCall(`${BASE}/${enc(id)}/files/${enc(slot)}/_read-brand`, {
    method: 'POST'
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
