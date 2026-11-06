// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import {
  fetchIntegrationFileMetadata,
  fetchIntegrationFilesProbe
} from '../../../api/endpoints/integrationFiles';
import { documentFailureKind, documentKindOf, documentRefOf } from '../utils/pendingDocument';

/** The integration answered 404 because it has no details route, not because the document is gone. */
const NO_DETAILS_MESSAGE = 'This integration has no details';

/**
 * Checks, with the signed-in user's own rights, that the integration a link names can hand
 * documents to this user and that the document exists and may be read, so the picker can say so
 * before an app is chosen instead of after.
 *
 * `status`:
 * - `none`        no pending document
 * - `checking`    the integration has not answered yet
 * - `ready`       the document is there (`title`, `kind`, `info` filled in)
 * - `unavailable` the integration is not installed, not configured or not granted (404/403 of the
 *                 probe): no document can come from it
 * - `noAccess`    the document is not readable (401/403)
 * - `notFound`    the document does not exist (404)
 * - `unverified`  the check itself failed (5xx, network) or the integration has no details route:
 *                 the document is not ruled out, and the chat reports a real failure
 *
 * `info` is the probe's answer (`{ id, definition, type, name }`) once the integration answered,
 * which is what an app's bindings are matched against; `kind` is what the document becomes as an
 * attachment (`image` | `audio` | `document`).
 *
 * @param {{documentId: string, integration: string, searchProfile?: string}|null} doc
 * @returns {{status: string, title: string, info: Object|null, kind: string}}
 */
export default function usePendingDocumentCheck(doc) {
  const documentId = doc?.documentId;
  const integration = doc?.integration;
  const searchProfile = doc?.searchProfile;
  const key = documentId ? `${integration}\u0000${documentId}\u0000${searchProfile || ''}` : null;
  const [result, setResult] = useState({ key: null });

  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const settle = (status, rest = {}) => {
      if (!signal.aborted)
        setResult({ key, status, title: '', info: null, kind: 'document', ...rest });
    };
    const ref = documentRefOf({ documentId, searchProfile });

    (async () => {
      let info;
      try {
        info = await fetchIntegrationFilesProbe({ integration, signal });
      } catch (err) {
        const httpStatus = err?.response?.status;
        return settle(httpStatus === 404 || httpStatus === 403 ? 'unavailable' : 'unverified');
      }
      try {
        const details = await fetchIntegrationFileMetadata({ integration, ref, signal });
        return settle('ready', {
          info,
          title: String(details?.title || ''),
          kind: documentKindOf({ mediaType: details?.mediaType, filename: details?.filename })
        });
      } catch (err) {
        const httpStatus = err?.response?.status;
        const failure = documentFailureKind(httpStatus);
        const noDetails = httpStatus === 404 && err?.response?.data?.error === NO_DETAILS_MESSAGE;
        return settle(noDetails || failure === 'failed' ? 'unverified' : failure, { info });
      }
    })();

    return () => controller.abort();
  }, [key, documentId, integration, searchProfile]);

  if (!key) return { status: 'none', title: '', info: null, kind: 'document' };
  // A result for a previous document is stale until the new check answers.
  if (result.key !== key) return { status: 'checking', title: '', info: null, kind: 'document' };
  return { status: result.status, title: result.title, info: result.info, kind: result.kind };
}
