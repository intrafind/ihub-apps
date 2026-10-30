// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Messages for the errors of the projects API (#1036, spec 1 §5.4 and spec 3
 * §9). The server answers `{ error, details: { code, limit?, used?, … } }`
 * (the chat route answers `{ error, code }`); these helpers find the code
 * wherever the API client put it and turn it into a translated message a
 * user can act on. Unknown codes keep the server's own wording.
 *
 * @module features/projects/utils/projectErrors
 */

import { formatBytes } from '../../admin/utils/systemResourcesFormat';

/**
 * The parts of a failed projects call the UI needs.
 *
 * @param {Error & {originalError?: Object, response?: Object, status?: number,
 *   originalMessage?: string}} error - Thrown by an API call (axios error, or
 *   the enhanced error of `handleApiResponse`).
 * @returns {{code: string|null, status: number|null, message: string,
 *   details: Object}}
 */
export function projectErrorDetails(error) {
  const response = error?.originalError?.response || error?.response || null;
  const data = response?.data && typeof response.data === 'object' ? response.data : {};
  const details = data.details && typeof data.details === 'object' ? data.details : {};
  return {
    code: details.code || data.code || error?.code || null,
    status: response?.status ?? error?.status ?? null,
    message: data.error || error?.originalMessage || error?.message || '',
    details
  };
}

/** Megabytes of a byte limit, for the quota messages. */
const size = bytes => formatBytes(Number(bytes));

/**
 * iFinder failed while it changed a collection. The call is not atomic, so the
 * message says what the server found out afterwards: which documents made it.
 */
function ifinderWriteFailedMessage(details, message, t) {
  const done = (details.added || details.removed || []).length;
  const not = (details.not || []).length;
  if (details.outcome === 'partial') {
    return t(
      'projects.errors.ifinderWritePartial',
      'iFinder reported an error after part of the change went through: {{done}} done, {{not}} not. Reload the collection and try again.',
      { done, not }
    );
  }
  if (details.outcome === 'none') {
    return t(
      'projects.errors.ifinderWriteNone',
      'iFinder reported an error and nothing was changed. Try again in a moment.'
    );
  }
  return (
    message ||
    t(
      'projects.errors.ifinderWriteUnknown',
      'iFinder did not answer, so it is not known whether the change went through. Reload the collection to see.'
    )
  );
}

/**
 * A message for a failed projects call.
 *
 * @param {Error} error - Thrown by an API call.
 * @param {Function} t - i18next `t`.
 * @returns {string}
 *
 * @example
 * projectErrorMessage(quotaError, t)
 * // => 'This project already holds 25 items, the most it may hold.'
 */
export function projectErrorMessage(error, t) {
  const { code, message, details } = projectErrorDetails(error);
  switch (code) {
    case 'QUOTA_PROJECTS':
      return t(
        'projects.errors.quotaProjects',
        'The owner already has {{limit}} projects, the most one person may own.',
        { limit: details.limit ?? '' }
      );
    case 'QUOTA_FILES':
      return t(
        'projects.errors.quotaFiles',
        'This project already holds {{limit}} items, the most it may hold.',
        { limit: details.limit ?? '' }
      );
    case 'QUOTA_FILE_BYTES':
      return t('projects.errors.quotaFileBytes', 'A file may be at most {{limit}}.', {
        limit: size(details.limit)
      });
    case 'QUOTA_PROJECT_BYTES':
      return t(
        'projects.errors.quotaProjectBytes',
        'This project may hold at most {{limit}}; {{used}} are used.',
        { limit: size(details.limit), used: size(details.used ?? 0) }
      );
    case 'UNSUPPORTED_TYPE':
      return details.accepted?.summary
        ? t(
            'projects.errors.unsupportedTypeWith',
            'This file type is not supported. Supported: {{types}}.',
            {
              types: details.accepted.summary
            }
          )
        : t('projects.errors.unsupportedType', 'This file type is not supported.');
    case 'SOURCE_FORBIDDEN':
      return t(
        'projects.errors.sourceForbidden',
        'Connect the integration first, or you have no access to this document. ({{message}})',
        { message }
      );
    case 'SOURCE_GONE':
      return t('projects.errors.sourceGone', 'The source document was removed.');
    case 'STORAGE_UNAVAILABLE':
    case 'INGEST_UNAVAILABLE':
      return t(
        'projects.errors.storageUnavailable',
        'Projects are not available on this installation.'
      );
    case 'USER_PROJECTS_DISABLED':
      return t('projects.errors.userProjectsDisabled', 'User projects are switched off.');
    case 'PERMISSION_DENIED':
    case 'PROJECTS_NOT_ALLOWED':
      return t('projects.errors.permissionDenied', 'You are not allowed to do this.');
    case 'PROJECT_NOT_FOUND':
      return t(
        'projects.errors.notFound',
        'This project does not exist or you no longer have access to it.'
      );
    case 'PROJECT_ACCESS_CHANGED':
      return t(
        'projects.errors.accessChanged',
        'Your access to this project changed in the meantime. Reload the page.'
      );
    case 'PROJECT_MISMATCH':
      return t(
        'projects.errors.mismatch',
        'This chat already belongs to another project. Move it from the chat menu instead.'
      );
    case 'SHARE_TARGET_INVALID':
      return t(
        'projects.errors.shareTargetInvalid',
        'One of the people or groups cannot be added: {{message}}',
        { message }
      );
    case 'QUOTA_COLLECTION_DOCUMENTS':
      return t(
        'projects.errors.quotaCollectionDocuments',
        'A smart collection holds at most {{limit}} documents; this one already has {{used}}.',
        { limit: details.limit ?? '', used: details.used ?? '' }
      );
    case 'DOCUMENT_NOT_READABLE':
      return t(
        'projects.errors.documentNotReadable',
        'You cannot read this document in iFinder, so it cannot be added to a collection.'
      );
    case 'IFINDER_WRITES_DISABLED':
      return t(
        'projects.errors.ifinderWritesDisabled',
        'Changing smart collections from iHub is switched off on this installation. Change them in iFinder.'
      );
    case 'IFINDER_FORBIDDEN':
      return t(
        'projects.errors.ifinderForbidden',
        'iFinder does not allow your account to change smart collections.'
      );
    case 'TIER_NOT_AVAILABLE':
      return t(
        'projects.errors.tierNotAvailable',
        'Smart collections from iFinder are not available to you.'
      );
    case 'IFINDER_UNAVAILABLE':
      return t(
        'projects.errors.ifinderUnavailable',
        'iFinder could not be reached. Try again in a moment.'
      );
    case 'IFINDER_REJECTED':
      return t('projects.errors.ifinderRejected', 'iFinder did not accept the change.');
    case 'COLLECTION_BUSY':
      return t(
        'projects.errors.collectionBusy',
        'The collection is being changed right now. Try again in a moment.'
      );
    case 'IFINDER_WRITE_FAILED':
      return ifinderWriteFailedMessage(details, message, t);
    case 'KIND_NOT_ALLOWED':
      return t(
        'projects.errors.kindNotAllowed',
        'A smart collection from iFinder holds iFinder documents only.'
      );
    case 'KIND_DISABLED':
    case 'KIND_UNKNOWN':
      return t('projects.errors.kindDisabled', 'This kind of item is not available here.');
    case 'INVALID_REF':
      return t('projects.errors.invalidRef', 'The item could not be added: {{message}}', {
        message
      });
    default:
      return message || t('projects.errors.generic', 'Something went wrong. Please try again.');
  }
}

/**
 * The message of a failed or stale item (spec 3 §9): a hint the user can act
 * on for the codes that have one, otherwise the server's own message.
 *
 * @param {{status?: string, error?: {code?: string, message?: string}|null}} item
 * @param {Function} t - i18next `t`.
 * @returns {string|null}
 */
export function itemErrorMessage(item, t) {
  const code = item?.error?.code;
  const message = item?.error?.message || '';
  switch (code) {
    case 'NO_TEXT':
      return t(
        'projects.items.errors.noText',
        'This PDF has no text layer (scanned). Run it through OCR and upload the result.'
      );
    case 'SCAN_REJECTED':
      return t('projects.items.errors.scanRejected', 'Rejected by the malware scanner.');
    case 'INTERRUPTED':
      return t(
        'projects.items.errors.interrupted',
        'The upload was interrupted. Upload the file again.'
      );
    case 'UNSUPPORTED_TYPE':
      return t('projects.items.errors.unsupportedType', 'This file type is not supported.');
    case 'SOURCE_FORBIDDEN':
      return t(
        'projects.items.errors.sourceForbidden',
        'Connect the integration again; the document could not be read with your account.'
      );
    case 'SOURCE_GONE':
      return t('projects.items.errors.sourceGone', 'The source document was removed.');
    default:
      return message || null;
  }
}
