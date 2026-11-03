// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from '../client';
import { handleApiResponse } from './requestHandler';

/**
 * The file endpoints a chat, a scheduled task and a share all have in the same
 * shape: `<prefix>/:id/files[/:fileId]`.
 *
 * - upload: a `File`/`Blob` goes as multipart, anything else as JSON
 *   (`{ name, mimeType, text, pageImages, data, source }`, see
 *   `services/chatFiles/fileUploadRequest.js`);
 * - list / text: descriptors and extracted text;
 * - blob: the original binary (rejects with `status` 410 and
 *   `code: 'ORIGINAL_DISCARDED'` when only the text is kept);
 * - remove: the file, or with `onlyOriginal` just its binary.
 *
 * @param {string} prefix - `/chats`, `/scheduled-tasks` or `/shares`.
 * @param {Object} [requestOptions] - Extra axios options for every call.
 */
export function createFileApi(prefix, requestOptions = {}) {
  const filesOf = id => `${prefix}/${encodeURIComponent(id)}/files`;
  const fileOf = (id, fileId) => `${filesOf(id)}/${encodeURIComponent(fileId)}`;
  const need = (...values) => {
    if (values.some(value => !value)) throw new Error('Missing required parameters');
  };

  return {
    /**
     * @param {string} id
     * @param {File|Blob|Object} payload
     * @param {Object} [options]
     * @param {(percent: number) => void} [options.onProgress]
     * @param {AbortSignal} [options.signal]
     * @param {Object} [options.fields] - Extra multipart fields (`appId`, `ephemeral`).
     * @returns {Promise<{ file: Object }>}
     */
    upload(id, payload, { onProgress, signal, fields } = {}) {
      need(id, payload);
      const isBinary = typeof Blob !== 'undefined' && payload instanceof Blob;
      let body = payload;
      if (isBinary) {
        body = new FormData();
        for (const [key, value] of Object.entries(fields || {})) {
          if (value !== undefined && value !== null) body.append(key, String(value));
        }
        // Fields first: multer reads them before the file arrives.
        body.append('file', payload, payload.name || 'upload');
      } else if (fields) {
        body = { ...fields, ...payload };
      }
      return handleApiResponse(
        () =>
          apiClient.post(filesOf(id), body, {
            ...requestOptions,
            signal,
            // The server enforces its own size limit; a long upload must not
            // hit the default request timeout.
            timeout: 0,
            onUploadProgress: event => {
              if (!onProgress || !event?.total) return;
              onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
            }
          }),
        null,
        null
      );
    },

    /** @returns {Promise<{ items: Object[] }>} */
    list(id) {
      need(id);
      return handleApiResponse(() => apiClient.get(filesOf(id), requestOptions), null, null);
    },

    /** The extracted text: `{ file: { …descriptor, text, pageImages? } }`. */
    text(id, fileId) {
      need(id, fileId);
      return handleApiResponse(
        () => apiClient.get(fileOf(id, fileId), { ...requestOptions, params: { format: 'text' } }),
        null,
        null
      );
    },

    /** The original binary as a Blob. */
    async blob(id, fileId) {
      need(id, fileId);
      const response = await apiClient.get(fileOf(id, fileId), {
        ...requestOptions,
        responseType: 'blob'
      });
      return response.data;
    },

    /** @returns {Promise<{ deleted: boolean }|{ file: Object }>} */
    remove(id, fileId, { onlyOriginal = false } = {}) {
      need(id, fileId);
      return handleApiResponse(
        () =>
          apiClient.delete(fileOf(id, fileId), {
            ...requestOptions,
            params: onlyOriginal ? { onlyOriginal: 1 } : undefined
          }),
        null,
        null
      );
    }
  };
}

export { isOriginalDiscarded } from './fileErrors';
