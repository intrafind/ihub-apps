// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getChatFileRepository } from '../chatFiles/ChatFileRepository.js';
import { DocumentGenerationError } from './renderService.js';

/**
 * Load the original binary of a file the user uploaded to the chat (or
 * attached to the scheduled task the current run belongs to), so a document
 * tool can use it as a template (`templateFileId`) or as the source of a
 * change (`sourceFileId`).
 *
 * Only files of the caller's own chat or task scope are reachable: the chat id
 * and the principal come from the trusted tool context, never from the
 * model's arguments.
 */

export const DOCX_FILE_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_FILE_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const XLSX_FILE_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_FILE_MIME = 'application/pdf';

const FORMAT_LABELS = {
  [DOCX_FILE_MIME]: 'Word (.docx)',
  [PPTX_FILE_MIME]: 'PowerPoint (.pptx)',
  [XLSX_FILE_MIME]: 'Excel (.xlsx)',
  [PDF_FILE_MIME]: 'PDF'
};

/**
 * The scopes in which a tool call may look for an uploaded file: the chat,
 * then the scheduled task of the current run.
 *
 * @param {{user?: Object, chatId?: string}} context
 * @returns {Array<{type: 'chat'|'task', id: string}>}
 */
export function uploadedFileScopes({ user, chatId } = {}) {
  const scopes = [];
  if (typeof chatId === 'string' && chatId) scopes.push({ type: 'chat', id: chatId });
  const taskId = user?.scheduledRun?.taskId;
  if (typeof taskId === 'string' && taskId) scopes.push({ type: 'task', id: taskId });
  return scopes;
}

/**
 * Read the original bytes of an uploaded file.
 *
 * @param {Object} params
 * @param {string} params.fileId - Id from the `<content id="…">` tag.
 * @param {string[]} params.mimeTypes - Media types the tool accepts.
 * @param {Object} [params.user]
 * @param {string} [params.chatId]
 * @param {string} [params.parameter='templateFileId'] - Argument name, for messages.
 * @param {import('../chatFiles/ChatFileRepository.js').ChatFileRepository} [params.repository]
 * @returns {Promise<{ buffer: Buffer, name: string, mimeType: string, fileId: string }>}
 * @throws {DocumentGenerationError} `invalid` when the file cannot be used.
 */
export async function loadUploadedFileOriginal({
  fileId,
  mimeTypes,
  user,
  chatId,
  parameter = 'templateFileId',
  repository = null
}) {
  const repo = repository || getChatFileRepository();
  if (typeof fileId !== 'string' || !fileId.trim()) {
    throw new DocumentGenerationError(`"${parameter}" must be a file id.`, 'invalid');
  }
  const id = fileId.trim();
  const expected = mimeTypes.map(type => FORMAT_LABELS[type] || type).join(' or ');
  if (!repo?.isAvailable?.()) {
    throw new DocumentGenerationError('Uploaded files are not available right now.', 'invalid');
  }

  for (const scope of uploadedFileScopes({ user, chatId })) {
    const original = await repo.getOriginal(scope, id);
    if (!original) continue;
    if (!mimeTypes.includes(original.mimeType)) {
      throw new DocumentGenerationError(
        `"${original.name}" is not a ${expected} file, so it cannot be used for "${parameter}".`,
        'invalid'
      );
    }
    if (original.discarded || !original.data) {
      throw new DocumentGenerationError(
        `The original of "${original.name}" is no longer stored (only its extracted text is), so it cannot be used for "${parameter}". Ask the user to upload the file again.`,
        'invalid'
      );
    }
    return {
      buffer: Buffer.from(original.data),
      name: original.name,
      mimeType: original.mimeType,
      fileId: id
    };
  }
  throw new DocumentGenerationError(
    `No uploaded file with id "${id}" is available in this chat. Use the id from the file's <content id="…"> tag (only files with can_use_as_template="true" qualify).`,
    'invalid'
  );
}

/**
 * Whether the user's uploaded file may replace the app's pinned corporate
 * document template. An app that pins none always allows it; an app that pins
 * one keeps its corporate design unless it sets `allowUserTemplateUploads`.
 *
 * @param {Object} [app]
 * @returns {boolean}
 */
export function userTemplateUploadsAllowed(app) {
  if (typeof app?.allowUserTemplateUploads === 'boolean') return app.allowUserTemplateUploads;
  return !(typeof app?.documentTemplate === 'string' && app.documentTemplate);
}
