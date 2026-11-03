// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat files a model asks to forward to a remote A2A agent (`fileIds` of an
 * `a2a__<agent>__<skill>` tool call).
 *
 * @module services/a2a/a2aFiles
 */
import { A2A_RESPONSE_LIMITS } from './a2aTools.js';
import { MAX_GENERATED_FILE_BYTES } from '../documents/generatedFiles.js';

/**
 * Resolve the `fileIds` of a tool call to the files to send: the stored
 * original (`getOriginal`) when the chat kept it, else the extracted text
 * (`getText`) as a plain text file. Only files of the chat the call runs in can
 * be named; ids are taken from the call's own context, never from the model's
 * other arguments.
 *
 * @param {Object} params - Params as handed to `runTool` (`fileIds`, `chatId`)
 * @param {Object} [options]
 * @param {Object} [options.store] - A `ChatFileRepository` (tests); defaults to the process-wide one
 * @returns {Promise<Array<{name: string, mimeType: string, bytes: Buffer}>>}
 * @throws {Error} The call names a file that is not in this chat, too many files or too much data
 */
export async function chatFilesToSend(params, { store = null } = {}) {
  const raw = params?.fileIds;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('"fileIds" must be an array of file ids');
  const ids = [...new Set(raw.filter(id => typeof id === 'string' && id))];
  if (ids.length === 0) return [];
  if (ids.length > A2A_RESPONSE_LIMITS.files) {
    throw new Error(`At most ${A2A_RESPONSE_LIMITS.files} files can be sent in one call`);
  }
  const chatId = typeof params.chatId === 'string' ? params.chatId : null;
  if (!chatId) throw new Error('Files can only be sent from a chat');
  const repository =
    store || (await import('../chatFiles/ChatFileRepository.js')).getChatFileRepository();
  const scope = { type: 'chat', id: chatId };
  const files = [];
  let total = 0;
  for (const id of ids) {
    const original = await repository.getOriginal(scope, id);
    let file = null;
    if (original?.data?.length) {
      file = { name: original.name, mimeType: original.mimeType, bytes: original.data };
    } else if (original) {
      const stored = await repository.getText(scope, id);
      if (stored?.text) {
        file = {
          name: /\.(txt|md|csv|json)$/i.test(stored.name) ? stored.name : `${stored.name}.txt`,
          mimeType: 'text/plain',
          bytes: Buffer.from(stored.text, 'utf8')
        };
      }
    }
    if (!file) throw new Error(`File ${id} was not found in this chat`);
    total += file.bytes.length;
    if (total > MAX_GENERATED_FILE_BYTES) {
      throw new Error(
        `The files are larger than ${MAX_GENERATED_FILE_BYTES / 1024 / 1024} MB together`
      );
    }
    files.push(file);
  }
  return files;
}
