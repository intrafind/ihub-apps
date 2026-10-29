// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { makeAdminApiCall } from './adminApi.js';

/**
 * Admin API for people directories (`contents/config/peopleDirectories.json`)
 * and their certificate store (`contents/config/certs/`). Every route sits
 * behind `adminAuth` on the server (`server/routes/admin/peopleDirectories.js`).
 *
 * The config file is read and written as a whole: an editor loads the list,
 * replaces, adds or removes one entry and writes the whole list back.
 */

const BASE = '/admin/people-directories';

/**
 * Load the directories with what the server resolved for each of them.
 *
 * @returns {Promise<{
 *   directories: Array<Object>,
 *   effective: Object<string, {sourceType: string, source: string, preset: string, transport: string, external: boolean, problems: string[], warnings: string[]}>,
 *   ldapProviders: Array<{name: string, displayName?: string, url?: string, host?: string, baseDn?: string, preset?: string, starttls?: boolean, hasBindAccount?: boolean}>,
 *   peopleSearchApp: {id: string, exists: boolean, enabled: boolean}
 * }>} The response body
 */
export async function fetchPeopleDirectories() {
  const response = await makeAdminApiCall(BASE);
  return response.data;
}

/**
 * Replace the whole directory list. The server validates it against its Zod
 * schema (400 with `details`) and against tool, MCP server and A2A agent ids
 * (409 with `conflict`).
 *
 * @param {Array<Object>} directories - Every directory, as stored
 * @returns {Promise<{success: boolean, directories: Array<Object>}>} The response body
 */
export async function savePeopleDirectories(directories) {
  const response = await makeAdminApiCall(BASE, {
    method: 'PUT',
    body: { directories }
  });
  return response.data;
}

/**
 * Load the search presets, the person fields a mapping can fill, and the
 * defaults and upper bounds of the limits.
 *
 * @returns {Promise<{presets: Array<Object>, fields: string[], defaults: Object, limits: Object}>}
 */
export async function fetchPeopleDirectoryPresets() {
  const response = await makeAdminApiCall(`${BASE}/presets`);
  return response.data;
}

/**
 * Run the connection test step by step: resolve, network check, connect,
 * StartTLS, bind, sample search and mapping.
 *
 * @param {{id?: string, directory?: Object}} target - A saved directory by id,
 *   or an unsaved directory as the editor holds it
 * @param {string} [query] - Name to search for in the sample search
 * @returns {Promise<{success: boolean, message?: string, summary?: Object, steps: Array<Object>, results?: Array<Object>}>}
 */
export async function testPeopleDirectory(target, query) {
  const body = { ...target };
  if (query && query.trim()) body.query = query.trim();
  const response = await makeAdminApiCall(`${BASE}/test`, { method: 'POST', body });
  return response.data;
}

/**
 * List the trust anchors in the certificate store, with the directories that
 * use each one.
 *
 * @returns {Promise<Array<Object>>} Certificate descriptions
 */
export async function fetchDirectoryCertificates() {
  const response = await makeAdminApiCall(`${BASE}/certificates`);
  return Array.isArray(response.data?.certificates) ? response.data.certificates : [];
}

/**
 * Parse a certificate without storing it, so the admin can compare its
 * fingerprint with the one the publisher lists before saving.
 *
 * @param {string} content - PEM text, or base64 of DER bytes
 * @param {'pem'|'base64'} encoding - How `content` is encoded
 * @returns {Promise<Object>} The parsed certificate
 */
export async function previewDirectoryCertificate(content, encoding) {
  const response = await makeAdminApiCall(`${BASE}/certificates/preview`, {
    method: 'POST',
    body: { content, encoding }
  });
  return response.data?.certificate;
}

/**
 * Store a certificate under a name (`^[a-z0-9-]+$`, at most 64 characters).
 *
 * @param {{name: string, content: string, encoding: 'pem'|'base64'}} certificate
 * @returns {Promise<Object>} The stored certificate
 */
export async function uploadDirectoryCertificate({ name, content, encoding }) {
  const response = await makeAdminApiCall(`${BASE}/certificates`, {
    method: 'POST',
    body: { name, content, encoding }
  });
  return response.data?.certificate;
}

/**
 * Remove a certificate from the store. The server refuses (409) while a
 * directory names it in `tlsCa`.
 *
 * @param {string} name - Certificate name
 * @returns {Promise<void>}
 */
export async function deleteDirectoryCertificate(name) {
  await makeAdminApiCall(`${BASE}/certificates/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  });
}
