// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Importing documents into a project (`POST …/items/_import`): copying a
 * generated file of a chat into a project ("Copy to project…"), and uploading a
 * ZIP archive that the server unpacks into one document per supported entry.
 *
 * The rules live here so the chat, the project page and the admin project page
 * agree on them; the components only render.
 *
 * @module features/projects/utils/projectImport
 */

import { isIFinderProject, memberCountOf } from './projectView';
import { projectErrorDetails, projectErrorMessage } from './projectErrors';

/** Types a browser reports for a ZIP archive. */
const ZIP_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'multipart/x-zip'
]);

/** The extension the upload pickers add to their accept list for archives. */
export const ZIP_ACCEPT = '.zip';

/**
 * Whether a picked file is a ZIP archive, which goes to `…/items/_import`
 * (unpacked on the server) instead of `…/items`. By its name first: browsers
 * report archives under several types, Windows often as
 * `application/x-zip-compressed`, some as `application/octet-stream`.
 *
 * @param {{name?: string, type?: string}|null|undefined} file
 * @returns {boolean}
 *
 * @example
 * isZipFile(new File([], 'export.zip')); // true
 */
export function isZipFile(file) {
  if (!file) return false;
  if (/\.zip$/i.test(String(file.name || ''))) return true;
  return ZIP_TYPES.has(String(file.type || '').toLowerCase());
}

/**
 * The upload input's `accept` list with ZIP archives added (when the list
 * restricts types at all; without one every file is accepted already).
 *
 * @param {string|undefined} accept - e.g. `.pdf,.docx,text/plain`
 * @returns {string|undefined}
 */
export function withZipAccept(accept) {
  if (!accept) return accept;
  const entries = accept.split(',').map(entry => entry.trim().toLowerCase());
  if (entries.includes(ZIP_ACCEPT) || entries.includes('application/zip')) return accept;
  return `${accept},${ZIP_ACCEPT}`;
}

/**
 * Whether a generated file may be copied into a project. Projects take
 * documents, not pictures: the server refuses images (`UNSUPPORTED_TYPE`), so
 * Copy to project is not offered for them. A live file (no id the server
 * knows yet) cannot be copied either.
 *
 * @param {{id?: string, kind?: string, mimeType?: string}|null|undefined} artifact
 * @returns {boolean}
 */
export function canCopyArtifactToProject(artifact) {
  if (!artifact?.id) return false;
  if (artifact.kind === 'image') return false;
  return !String(artifact.mimeType || '')
    .toLowerCase()
    .startsWith('image/');
}

/**
 * The projects a file can be copied into: user projects (not a smart
 * collection from iFinder) the caller may change — owner or editor, and not
 * read-only because the owner is gone.
 *
 * @param {Array<Object>} projects - `GET /api/projects` items.
 * @returns {Array<Object>}
 */
export function copyTargetProjects(projects) {
  return (Array.isArray(projects) ? projects : []).filter(
    project =>
      project?.ownership === 'user' &&
      !isIFinderProject(project) &&
      project.permissions?.canEdit === true &&
      project.permissions?.readOnly !== true
  );
}

/**
 * Who sees what is added to a project, for the "who will see it" line of the
 * copy dialog.
 *
 * @param {{audience?: {everyone?: boolean, catalog?: boolean}, members?: Array,
 *   memberCount?: number}|null|undefined} project
 * @returns {{kind: 'everyone'|'catalog'|'members'|'private', count: number}}
 *   `everyone`: shared with everyone signed in; `catalog`: published, so everyone
 *   signed in can read it; `members`: shared with `count` members, each a user or
 *   a whole group; `private`: only the caller.
 */
export function projectAudienceOf(project) {
  const count = memberCountOf(project);
  if (project?.audience?.everyone === true) return { kind: 'everyone', count };
  if (project?.audience?.catalog === true) return { kind: 'catalog', count };
  if (count > 0) return { kind: 'members', count };
  return { kind: 'private', count: 0 };
}

/**
 * The translated "who will see it" text of a project.
 *
 * @param {Object|null|undefined} project
 * @param {Function} t - i18next `t`.
 * @returns {string}
 */
export function projectAudienceLabel(project, t) {
  const { kind, count } = projectAudienceOf(project);
  switch (kind) {
    case 'everyone':
      return t('projects.import.audience.everyone', 'Everyone signed in');
    case 'catalog':
      return t('projects.import.audience.catalog', 'Everyone signed in (published in the catalog)');
    case 'members':
      // A member is a user or a whole group: the count is of grants, not people.
      return t('projects.import.audience.members', 'Shared with {{count}} people or groups', {
        count
      });
    default:
      return t('projects.import.audience.private', 'Only you');
  }
}

/**
 * The parts of an import answer the UI reports, however much of it the server
 * sent.
 *
 * @param {{items?: Array, skipped?: Array}|null|undefined} result
 * @returns {{added: number, skipped: Array<{name: string, code: string, message: string}>}}
 */
export function importSummary(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  return { added: items.length, skipped: skippedEntries(result?.skipped) };
}

/** Normalize a list of skipped entries (an answer's `skipped`, a refusal's `details.skipped`). */
function skippedEntries(list) {
  return (Array.isArray(list) ? list : []).map(entry => ({
    name: String(entry?.name || ''),
    code: String(entry?.code || ''),
    message: String(entry?.message || '')
  }));
}

/**
 * The message of a refused import. The server's own `detail` comes first — it
 * says what was wrong with this file (`415 UNSUPPORTED_TYPE`: an image, a type
 * projects do not take, an archive with nothing usable; `413 QUOTA_*`) — and the
 * translated message of the code only when it sent none.
 *
 * @param {Error} error - Thrown by `importProjectItems` / `importAdminProjectItems`.
 * @param {Function} t - i18next `t`.
 * @returns {string}
 */
export function importErrorMessage(error, t) {
  const response = error?.originalError?.response || error?.response;
  const detail = response?.data && typeof response.data === 'object' ? response.data.detail : '';
  return typeof detail === 'string' && detail.trim() ? detail : projectErrorMessage(error, t);
}

/**
 * What a refused archive import skipped (`details.skipped` of a `415`), so the
 * user learns why each entry was not taken.
 *
 * @param {Error} error
 * @returns {Array<{name: string, code: string, message: string}>}
 */
export function importErrorSkipped(error) {
  return skippedEntries(projectErrorDetails(error).details?.skipped);
}

/**
 * Upload the files one by one (each is its own request with its own status,
 * spec 3 §2). A failure does not stop the others.
 *
 * A ZIP archive goes to `…/items/_import` when the API offers it
 * (`api.importItem`): the server unpacks it into one item per supported entry
 * and names the entries it skipped. A refused archive (`415`) also lists them.
 *
 * @param {Object} api - See `AddProjectItemDialog`.
 * @param {string} projectId
 * @param {Array<File>} files
 * @param {{name: string, pinned: boolean}} options
 * @param {Function} t - i18next `t`, for the message of a refused archive.
 * @returns {Promise<{added: Array<Object>, uploaded: Array<File>, failures: string[],
 *   archives: Array<{name: string, summary: {added: number, skipped: Array<Object>}}>}>}
 *   `uploaded`: the files that were added; `archives`: what each imported archive did.
 */
export async function uploadProjectFiles(api, projectId, files, { name, pinned }, t) {
  const added = [];
  const uploaded = [];
  const failures = [];
  const archives = [];
  const label = (file, message) => (files.length === 1 ? message : `${file.name}: ${message}`);
  for (const file of files) {
    const archive = isZipFile(file) && typeof api.importItem === 'function';
    try {
      if (archive) {
        const result = await api.importItem(projectId, { file, pinned });
        added.push(...(result?.items || []));
        archives.push({ name: file.name, summary: importSummary(result) });
      } else {
        added.push(
          await api.uploadItem(projectId, {
            file,
            name: files.length === 1 ? name || undefined : undefined,
            pinned
          })
        );
      }
      uploaded.push(file);
    } catch (err) {
      if (!archive) {
        failures.push(label(file, api.errorMessage(err)));
        continue;
      }
      // The server's own `detail` says why (nothing usable inside, a quota), and what it skipped.
      const skipped = importErrorSkipped(err);
      failures.push(
        [
          label(file, importErrorMessage(err, t)),
          ...skipped.map(entry =>
            entry.message ? `  ${entry.name}: ${entry.message}` : `  ${entry.name}`
          )
        ].join('\n')
      );
    }
  }
  return { added, uploaded, failures, archives };
}
