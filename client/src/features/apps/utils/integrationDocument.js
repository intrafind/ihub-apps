// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { fetchIntegrationFileContent } from '../../../api/endpoints/integrationFiles';
import { filenameFromContentDisposition } from '../../../utils/externalNavigation';

/**
 * A document of an installed integration as a `File`, for the chat to attach:
 * the **original**, named as the integration sent it, so an image stays an image
 * for a vision model and a Word file keeps its original next to its text.
 *
 * Only when the integration answers the request for the original with an error
 * other than a sign-in or permission failure (a document of which it keeps only
 * the text) is the text fetched, as a `.txt`; a timeout, an abort or a
 * permission failure applies to the text as well and is thrown.
 *
 * @param {Object} options
 * @param {string} options.integration - installation id
 * @param {{id: string, scope?: string}} options.ref
 * @param {string} options.fallbackName - the name when the integration sends none
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<File>}
 */
export async function fetchIntegrationDocumentFile({ integration, ref, fallbackName, signal }) {
  let response;
  try {
    response = await fetchIntegrationFileContent({ integration, ref, format: 'original', signal });
  } catch (binaryError) {
    const status = binaryError?.response?.status;
    if (!status || status === 401 || status === 403 || status === 404) throw binaryError;
    const text = await fetchIntegrationFileContent({ integration, ref, format: 'text', signal });
    const name = fallbackName.endsWith('.txt') ? fallbackName : `${fallbackName}.txt`;
    return new File([text.data], name, { type: 'text/plain' });
  }
  const fileName =
    filenameFromContentDisposition(response.headers?.['content-disposition']) || fallbackName;
  const contentType = response.headers?.['content-type'] || 'application/octet-stream';
  return new File([response.data], fileName, { type: contentType });
}
