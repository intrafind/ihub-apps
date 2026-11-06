// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { fetchSourceMetadata } from '../../../api/endpoints/sources';
import { documentFailureKind } from '../utils/pendingDocument';

/** The provider answered 404 because it has no details route, not because the document is gone. */
const NO_DETAILS_MESSAGE = 'This source provider has no details';

/**
 * Checks, with the signed-in user's own rights, that the pending document exists and may be read,
 * so the picker can say so before an app is chosen instead of after.
 *
 * `status`:
 * - `none`       no pending document
 * - `checking`   the provider has not answered yet
 * - `ready`      the document is there (`title` is its title when the provider sent one)
 * - `noAccess`   401/403
 * - `notFound`   404
 * - `unverified` the provider has no details route, or the check itself failed (5xx, network):
 *                the document is not ruled out, and `AppChat` reports a real failure
 *
 * @param {{documentId: string, source: string, searchProfile?: string}|null} doc
 * @returns {{status: string, title: string}}
 */
export default function usePendingDocumentCheck(doc) {
  const documentId = doc?.documentId;
  const source = doc?.source;
  const searchProfile = doc?.searchProfile;
  const key = documentId ? `${source}\u0000${documentId}\u0000${searchProfile || ''}` : null;
  const [result, setResult] = useState({ key: null, status: 'none', title: '' });

  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const ref = searchProfile ? { id: documentId, scope: searchProfile } : { id: documentId };

    fetchSourceMetadata({ source: { provider: source, ref }, signal: controller.signal })
      .then(details => {
        setResult({ key, status: 'ready', title: String(details?.title || '') });
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        const httpStatus = err?.response?.status;
        const kind = documentFailureKind(httpStatus);
        const noDetails = httpStatus === 404 && err?.response?.data?.error === NO_DETAILS_MESSAGE;
        setResult({
          key,
          status: noDetails || kind === 'failed' ? 'unverified' : kind,
          title: ''
        });
      });

    return () => controller.abort();
  }, [key, documentId, source, searchProfile]);

  if (!key) return { status: 'none', title: '' };
  // A result for a previous document is stale until the new check answers.
  if (result.key !== key) return { status: 'checking', title: '' };
  return { status: result.status, title: result.title };
}
